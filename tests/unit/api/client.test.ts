import { afterEach, describe, expect, it, vi } from "vitest";
import {
  validateConfig,
  NvrError,
  type NvrClient,
} from "../../../src/contracts";
import {
  createClientFactory,
  safeDiagnostic,
  selectSource,
} from "../../../src/api";
import { mapCamera } from "../../../src/api/mapping";
import { basicHeader } from "../../../src/api/safety";

const origin = "https://dashboard.example.invalid/";
const config = (extra: Record<string, unknown> = {}) =>
  validateConfig({
    type: "custom:lightnvr-camera-card",
    server: "/nvr/front",
    stream: "front_door",
    ...extra,
  });
const credentials = {
  username: "fixture-viewer",
  password: "generated-only:&?/#%+ 密碼é",
};
const identity = {
  authenticated: true,
  username: credentials.username,
  role: "viewer",
  must_change_password: false,
};
const json = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
const page = (
  names: string[] = [],
  current = 1,
  pages = 1,
  total = names.length,
) => ({
  streams: names.map((name) => ({ name, status: "Running", enabled: true })),
  page: current,
  page_size: 100,
  total,
  total_pages: pages,
});
const clients: NvrClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((c) => c.dispose());
  vi.useRealTimers();
});
function fixture(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
  extra = {},
) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(new URL(String(input)), init ?? {}),
  );
  const factory = createClientFactory({
    documentUrl: origin,
    fetch: fetch as typeof globalThis.fetch,
    ...extra,
  });
  const make = (overrides = {}) => {
    const client = factory(config(overrides));
    clients.push(client);
    return client;
  };
  return { fetch, make };
}
async function code(
  promise: Promise<unknown>,
  expected: string,
  status?: number,
) {
  await expect(promise).rejects.toMatchObject({
    failure: { code: expected, ...(status === undefined ? {} : { status }) },
  });
}

describe("connection and credential scopes", () => {
  it("identifies failed session verification without exposing the browser exception text", async () => {
    const f = fixture(() => {
      throw new TypeError("https://private.invalid/password=SECRET");
    });
    try {
      await f.make().connect();
      throw Error("expected failure");
    } catch (error) {
      expect(safeDiagnostic(error)).toMatchObject({
        code: "network",
        phase: "api-request",
        operation: "auth.verify",
        browserError: "TypeError",
      });
      expect(JSON.stringify(safeDiagnostic(error))).not.toMatch(
        /private|SECRET|password/,
      );
    }
  });
  it("requests JSON for cookie verification and preserves a readable HTTP auth denial", async () => {
    const f = fixture((_url, init) => {
      expect(new Headers(init.headers).get("Accept")).toBe("application/json");
      return json({}, 401);
    });
    try {
      await f.make().connect();
      throw Error("expected failure");
    } catch (error) {
      expect(safeDiagnostic(error)).toMatchObject({
        code: "auth",
        status: 401,
        phase: "http-response",
        operation: "auth.verify",
      });
    }
  });
  it.each([undefined, "unexpected", "same-site-session-v1"])(
    "requires an explicit HTTPS gateway marker for cross-origin cookie media: %s",
    async (marker) => {
      const f = fixture(() =>
        json(
          identity,
          200,
          marker ? { "X-LightNVR-Card-Gateway": marker } : {},
        ),
      );
      const c = f.make({ server: "https://nvr.example.invalid/ha-card/" });
      expect(c.profile.sameOrigin).toBe(false);
      expect(c.cookieMediaAllowed?.()).toBe(false);
      await c.verify();
      expect(c.cookieMediaAllowed?.()).toBe(marker === "same-site-session-v1");
      expect(c.profile.sameOrigin).toBe(false);
      expect(f.fetch.mock.calls[0]?.[1]?.credentials).toBe("include");
    },
  );
  it("does not trust a gateway marker received over HTTP", async () => {
    const f = fixture(() =>
      json(identity, 200, {
        "X-LightNVR-Card-Gateway": "same-site-session-v1",
      }),
    );
    const c = f.make({ server: "http://nvr.example.invalid/ha-card/" });
    await c.verify();
    expect(c.cookieMediaAllowed?.()).toBe(false);
  });
  it("connects with viewer credentials, discovers and selects without admin calls", async () => {
    const f = fixture((url) =>
      url.pathname.endsWith("/verify")
        ? json({}, 401)
        : url.pathname.endsWith("/login")
          ? json({ success: true })
          : json(page(["front_door"])),
    );
    const c = f.make();
    expect(await c.connect(credentials)).toEqual({
      kind: "authenticated",
      mustChangePassword: false,
    });
    const inventory = await c.discover();
    expect(selectSource(config(), inventory)).toEqual({
      source: "front_door",
      camera: "front_door",
      profile: "main",
    });
    expect(
      f.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toEqual([
      "/nvr/front/api/auth/verify",
      "/nvr/front/api/auth/login",
      "/nvr/front/api/streams",
    ]);
    expect(JSON.parse(String(f.fetch.mock.calls[1]?.[1]?.body))).toEqual(
      credentials,
    );
  });
  it("single-flights concurrent and nearby login across referenced clients", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(async (url) => {
      if (url.pathname.endsWith("/verify")) return json({}, 401);
      await pending;
      return json({ success: true });
    });
    const a = f.make(),
      b = f.make();
    const first = a.login(credentials),
      second = b.login(credentials);
    release();
    await Promise.all([first, second]);
    await b.login(credentials);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("cancels one login waiter without interrupting another card", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(async (url) => {
      if (url.pathname.endsWith("/verify")) return json({}, 401);
      await pending;
      return json({ success: true });
    });
    const a = f.make(),
      b = f.make(),
      abort = new AbortController();
    const first = a.login(credentials, { signal: abort.signal });
    const second = b.login(credentials);
    abort.abort();
    await code(first, "cancelled");
    a.dispose();
    release();
    expect((await second).kind).toBe("authenticated");
  });
  it("rejects a different existing cookie identity without sending a login", async () => {
    const f = fixture(() =>
      json({ ...identity, username: "other-fixture-viewer" }),
    );
    await code(f.make().login(credentials), "configuration");
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("does not silently change a claimed identity, including from config", async () => {
    const f = fixture(() => json(identity));
    const a = f.make();
    await a.connect();
    await code(a.login({ ...credentials, username: "other" }), "configuration");
    expect(() => f.make({ username: "other", password: "synthetic" })).toThrow(
      NvrError,
    );
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("invalidates cached inventory on changed password and sends exact new bytes", async () => {
    let calls = 0;
    const f = fixture((url) =>
      url.pathname.endsWith("/verify")
        ? json(identity)
        : url.pathname.endsWith("/login")
          ? json({ success: true })
          : json(page([`fixture_${++calls}`])),
    );
    const a = f.make();
    await a.login(credentials);
    expect((await a.discover())[0]?.name).toBe("fixture_1");
    await a.login({ ...credentials, password: "new %+ 密碼" });
    expect((await a.discover())[0]?.name).toBe("fixture_2");
    expect(
      f.fetch.mock.calls
        .filter(([url]) => String(url).endsWith("/login"))
        .map(([, init]) => JSON.parse(String(init?.body)).password),
    ).toEqual([credentials.password, "new %+ 密碼"]);
  });
  it("refuses password replacement while another client holds the scope", async () => {
    const f = fixture((url) =>
      url.pathname.endsWith("/login")
        ? json({ success: true })
        : json(identity),
    );
    const a = f.make(),
      b = f.make();
    await a.login(credentials);
    await code(
      b.login({ ...credentials, password: "changed" }),
      "configuration",
    );
  });
  it("verifies the cookie again after final disposal, retaining no implicit identity switch", async () => {
    const f = fixture(() => json(identity));
    const a = f.make();
    await a.connect();
    a.dispose();
    await code(
      f.make().login({ ...credentials, username: "different" }),
      "configuration",
    );
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("supports an interactive TOTP challenge but never automatically supplies a code", async () => {
    const f = fixture((url) =>
      url.pathname.endsWith("/verify")
        ? json({}, 401)
        : url.pathname.endsWith("/totp")
          ? json({ success: true })
          : json({ totp_required: true, totp_token: "generated-challenge" }),
    );
    const a = f.make();
    expect(await a.login(credentials)).toEqual({
      kind: "totp-required",
      challenge: "generated-challenge",
    });
    await code(a.completeTotp("wrong", "123456"), "totp");
    await code(a.completeTotp("generated-challenge", "bad"), "totp");
    expect((await a.completeTotp("generated-challenge", "123456")).kind).toBe(
      "authenticated",
    );
    expect(JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body))).toEqual({
      totp_token: "generated-challenge",
      code: "123456",
    });
  });
  it("represents password-change-required without exposing a redirect", async () => {
    const f = fixture((url) =>
      url.pathname.endsWith("/verify")
        ? json({}, 401)
        : json({
            success: true,
            must_change_password: true,
            redirect: "https://private.example.invalid/?secret",
          }),
    );
    expect(await f.make().login(credentials)).toEqual({
      kind: "password-change-required",
    });
  });
  it.each([401, 403, 423])(
    "stops a rejected/locked login (%s) without retrying",
    async (status) => {
      const f = fixture((url) =>
        url.pathname.endsWith("/verify")
          ? json({}, 401)
          : json({ error: "sensitive upstream detail" }, status),
      );
      await code(
        f.make().login(credentials),
        status === 403 ? "policy" : "auth",
        status,
      );
      expect(f.fetch).toHaveBeenCalledTimes(2);
    },
  );
  it("bounds rate-limit cooldown and does not automatically retry login", async () => {
    let now = 0;
    const f = fixture(
      (url) =>
        url.pathname.endsWith("/verify")
          ? json({}, 401)
          : json({}, 429, { "Retry-After": "10" }),
      { now: () => now },
    );
    const a = f.make();
    await code(a.login(credentials), "rate-limit", 429);
    await code(a.login(credentials), "rate-limit", 429);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    now = 10001;
    await code(a.login(credentials), "rate-limit", 429);
    expect(f.fetch).toHaveBeenCalledTimes(4);
  });
  it("uses tested same-origin Basic fetch with UTF-8 credentials and no cookies", async () => {
    const f = fixture(() => json(identity));
    const a = f.make({ auth: "basic" });
    await a.connect(credentials);
    const init = f.fetch.mock.calls[0]?.[1];
    expect(init?.credentials).toBe("omit");
    const encoded = new Headers(init?.headers).get("Authorization")!.slice(6);
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(
      `${credentials.username}:${credentials.password}`,
    );
    expect(() => basicHeader("invalid:name", "synthetic")).toThrow(NvrError);
  });
  it("rejects direct cross-origin Basic mode before sending credentials", async () => {
    const f = fixture(() => json(identity));
    await code(
      f
        .make({ auth: "basic", server: "https://nvr.example.invalid/" })
        .login(credentials),
      "configuration",
    );
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

describe("discovery, mapping and metadata cache", () => {
  it("walks all pages of more than 100 authorized streams", async () => {
    const f = fixture((url) => {
      expect(url.searchParams.get("surface")).toBe("live");
      expect(url.searchParams.get("availability")).toBe("all");
      const p = Number(url.searchParams.get("page"));
      return json(
        page(
          Array.from(
            { length: p === 3 ? 5 : 100 },
            (_, i) => `fixture_${(p - 1) * 100 + i}`,
          ),
          p,
          3,
          205,
        ),
      );
    });
    expect(await f.make().discover()).toHaveLength(205);
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });
  it("distinguishes an authorized empty inventory from a 401", async () => {
    const f = fixture(() => json(page([], 1, 0, 0)));
    expect(await f.make().discover()).toEqual([]);
    const denied = fixture(() => json({}, 401));
    await code(denied.make().discover(), "auth", 401);
  });
  it.each([
    { page: 2 },
    { total_pages: 10001 },
    { streams: [{ name: "same" }, { name: "same" }] },
  ])("rejects malformed or unbounded pagination %j", async (extra) => {
    const f = fixture(() => json({ ...page(), ...extra }));
    await code(f.make().discover(), "unsupported-api");
  });
  it("distinguishes literal _sub names, derived sub profiles, UUID selection and manual sources", () => {
    const inventory = [
      mapCamera({
        name: "front_door",
        camera_uuid: "fixture-id",
        has_sub_stream: true,
      }),
      mapCamera({ name: "front_door_sub" }),
    ];
    expect(selectSource(config({ profile: "sub" }), inventory)).toMatchObject({
      camera: "front_door",
      source: "front_door_sub",
      profile: "sub",
    });
    expect(
      selectSource(config({ stream: "front_door_sub" }), inventory),
    ).toMatchObject({
      camera: "front_door_sub",
      source: "front_door_sub",
      profile: "main",
    });
    expect(
      selectSource(
        config({ stream: "renamed", camera_uuid: "fixture-id" }),
        inventory,
      ),
    ).toMatchObject({ camera: "front_door", uuid: "fixture-id" });
    expect(
      selectSource(
        config({ stream: "manual", source: "front_door_sub" }),
        inventory,
      ),
    ).toEqual({ source: "front_door_sub", profile: "main" });
    expect(() =>
      selectSource(
        config({ stream: "front_door_sub", profile: "sub" }),
        inventory,
      ),
    ).toThrow(NvrError);
  });
  it.each([
    ["Running", "online"],
    ["running", "online"],
    ["Error", "offline"],
    ["Stopped", "offline"],
    ["Starting", "unknown"],
    ["Degraded", "unknown"],
    ["Future", "unknown"],
  ])("maps real wire status %s to %s", (status, expected) => {
    expect(mapCamera({ name: "fixture", status }).status).toBe(expected);
    expect(mapCamera({ name: "fixture", status, enabled: false }).status).toBe(
      "disabled",
    );
  });
  it.each([
    ["auto", undefined],
    ["webrtc_only", "webrtc"],
    ["mse_only", "mse"],
    ["hls_only", "hls"],
    ["webrtc_then_mse", "webrtc"],
    ["mse_then_hls", "mse"],
  ])(
    "maps upstream preference %s without imposing a fallback order",
    (playback_transport, preferred) => {
      expect(
        mapCamera({ name: "fixture", playback_transport }).preferredTransport,
      ).toBe(preferred);
    },
  );
  it("keeps unknown permissions honest and strips URL/credential wire fields", async () => {
    const f = fixture(() =>
      json({
        ...page(),
        streams: [
          {
            name: "fixture",
            ptz_enabled: true,
            backchannel_enabled: true,
            url: "rtsp://sensitive.invalid",
            password: "synthetic-secret",
            can_control_privacy: false,
          },
        ],
      }),
    );
    const result = await f.make().discover();
    expect(result[0]?.capabilities).toMatchObject({
      ptz: "unknown",
      "audio.listen": "unknown",
      "audio.talk": "unknown",
      privacy: "denied",
      snapshot: "unknown",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /sensitive|synthetic-secret|rtsp/,
    );
  });
  it("shares bounded immutable cache while referenced and evicts after TTL or final disposal", async () => {
    let now = 0;
    const f = fixture(() => json(page(["fixture"])), {
      now: () => now,
      cacheTtlMs: 1000,
    });
    const a = f.make(),
      b = f.make();
    const inventory = await a.discover();
    expect(await b.discover()).toBe(inventory);
    expect(Object.isFrozen(inventory[0]?.sources)).toBe(true);
    a.dispose();
    expect(await b.discover()).toBe(inventory);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    now = 1001;
    await b.discover();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    b.dispose();
    await f.make().discover();
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });
  it("maps only safe config fields and preserves unknown policy in older responses", async () => {
    const f = fixture(() =>
      json({
        go2rtc_enabled: true,
        go2rtc_available: true,
        audio_disabled: true,
        webrtc_disabled: false,
        mse_disabled: true,
        default_playback_transport: "webrtc_then_mse",
        password: "fixture-secret",
      }),
    );
    const c = await f.make().clientConfig();
    expect(c).toMatchObject({
      go2rtc: "allowed",
      audioDisabled: true,
      forceNativeHls: "unknown",
      defaultTransport: "webrtc",
      transports: { webrtc: "allowed", mse: "denied", hls: "unknown" },
    });
    expect(JSON.stringify(c)).not.toContain("fixture-secret");
  });
  it("does not override a go2rtc denial with available flags", async () => {
    const f = fixture(() =>
      json({
        go2rtc_enabled: false,
        go2rtc_available: true,
        webrtc_disabled: false,
        mse_disabled: false,
      }),
    );
    expect((await f.make().clientConfig()).transports).toMatchObject({
      webrtc: "denied",
      mse: "denied",
    });
  });
});

describe("cancellation, errors and recovery", () => {
  it("reauthenticates a GET once, then stops on another 401", async () => {
    const f = fixture((url) =>
      url.pathname.endsWith("/login") ? json({ success: true }) : json({}, 401),
    );
    const a = f.make();
    await a.login(credentials);
    await code(a.discover(), "auth", 401);
    expect(
      f.fetch.mock.calls.filter(([url]) => String(url).endsWith("/login")),
    ).toHaveLength(2);
    expect(
      f.fetch.mock.calls.filter(([url]) => String(url).includes("/streams?")),
    ).toHaveLength(2);
  });
  it("never reauthenticates or retries on 403", async () => {
    const f = fixture((url) =>
      url.pathname.endsWith("/verify")
        ? json(identity)
        : url.pathname.endsWith("/login")
          ? json({ success: true })
          : json({}, 403),
    );
    const a = f.make();
    await a.login(credentials);
    const count = f.fetch.mock.calls.length;
    await code(a.discover(), "policy", 403);
    expect(f.fetch).toHaveBeenCalledTimes(count + 1);
  });
  it.each([
    ["<html>private proxy failure</html>", 502, "proxy"],
    ["go2rtc private source text", 500, "proxy"],
    ["<html>login password</html>", 200, "unsupported-api"],
  ])("sanitizes non-JSON failure (%s)", async (body, status, expected) => {
    const f = fixture(
      () =>
        new Response(body, {
          status: Number(status),
          headers: { "Content-Type": "text/html" },
        }),
    );
    try {
      await f.make().discover();
      throw new Error("expected failure");
    } catch (error) {
      expect(safeDiagnostic(error).code).toBe(expected);
      expect(JSON.stringify(error)).not.toMatch(/private|password|<html>/);
    }
  });
  it("keeps offline/network failure recoverable without caching a failure", async () => {
    let offline = true;
    const f = fixture(() => {
      if (offline) throw new Error("private URL with credentials");
      return json(page(["fixture"]));
    });
    const a = f.make();
    await code(a.discover(), "network");
    offline = false;
    expect(await a.discover()).toHaveLength(1);
  });
  it("cancels stale pagination before another page and does not publish it into cache", async () => {
    const abort = new AbortController();
    let first = true;
    const f = fixture(() => {
      if (first) {
        first = false;
        abort.abort();
        return json(page(["stale"], 1, 2, 101));
      }
      return json(page(["fresh"]));
    });
    const a = f.make();
    await code(a.discover({ signal: abort.signal }), "cancelled");
    expect((await a.discover())[0]?.name).toBe("fresh");
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("cancels an outstanding body read on caller abort", async () => {
    const abort = new AbortController();
    const cancelled = vi.fn();
    const f = fixture(
      () =>
        new Response(new ReadableStream({ cancel: cancelled }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    const read = f.make().discover({ signal: abort.signal });
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1));
    abort.abort();
    await code(read, "cancelled");
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it("bounds response-body waits by the request deadline", async () => {
    vi.useFakeTimers();
    const f = fixture(
      () =>
        new Response(new ReadableStream(), {
          headers: { "Content-Type": "application/json" },
        }),
      { requestTimeoutMs: 100 },
    );
    const read = f.make().discover();
    const rejection = code(read, "timeout");
    await vi.advanceTimersByTimeAsync(101);
    await rejection;
  });
  it("disposes repeatedly and aborts retained work", async () => {
    const f = fixture(
      () =>
        new Response(new ReadableStream(), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    const a = f.make();
    const read = a.discover();
    a.dispose();
    a.dispose();
    await code(read, "cancelled");
    await code(a.discover(), "cancelled");
  });
  it("redacts arbitrary diagnostics instead of forwarding raw exceptions", () => {
    expect(safeDiagnostic(new Error("secret https://private.invalid"))).toEqual(
      {
        code: "network",
        message: "A connection or playback operation failed.",
      },
    );
    const unsafe = new NvrError({
      code: "network",
      message: "SECRET",
      phase: "https://private.invalid" as never,
      operation: "PASSWORD" as never,
      browserError: "cookie=SECRET" as never,
    });
    expect(JSON.stringify(safeDiagnostic(unsafe))).not.toMatch(
      /SECRET|private|PASSWORD|cookie/,
    );
  });
});

describe("credential and lifecycle races", () => {
  it("aborts stale discovery when credentials change before the body arrives", async () => {
    let pending = false;
    const cancelled = vi.fn();
    const f = fixture((url) => {
      if (url.pathname.endsWith("/verify")) return json(identity);
      if (url.pathname.endsWith("/login")) return json({ success: true });
      if (pending)
        return new Response(new ReadableStream({ cancel: cancelled }), {
          headers: { "Content-Type": "application/json" },
        });
      return json(page(["fresh"]));
    });
    const a = f.make();
    await a.login(credentials);
    pending = true;
    const stale = a.discover();
    const rejection = code(stale, "cancelled");
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(3));
    await a.login({
      ...credentials,
      password: "replacement-generated-password",
    });
    await rejection;
    expect(cancelled).toHaveBeenCalledTimes(1);
    pending = false;
    expect((await a.discover())[0]?.name).toBe("fresh");
  });
  it("single-flights reauthentication for concurrent expired reads", async () => {
    let expired = false,
      logins = 0;
    const f = fixture((url) => {
      if (url.pathname.endsWith("/verify"))
        return expired ? json({}, 401) : json(identity);
      if (url.pathname.endsWith("/login")) {
        logins++;
        expired = false;
        return json({ success: true });
      }
      return expired ? json({}, 401) : json(page(["fixture"]));
    });
    const a = f.make(),
      b = f.make();
    await a.login(credentials);
    expired = true;
    const [first, second] = await Promise.all([a.discover(), b.discover()]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(logins).toBe(2);
  });
  it("keeps distinct proxy prefixes and their identities/cache independent", async () => {
    const f = fixture((url) => {
      const front = url.pathname.startsWith("/nvr/front/");
      if (url.pathname.endsWith("/verify"))
        return json({
          ...identity,
          username: front ? "front-fixture-viewer" : "rear-fixture-viewer",
        });
      if (url.pathname.endsWith("/login")) return json({ success: true });
      return json(page([front ? "front-fixture" : "rear-fixture"]));
    });
    const a = f.make(),
      b = f.make({ server: "/nvr/rear" });
    await Promise.all([
      a.login({ ...credentials, username: "front-fixture-viewer" }),
      b.login({ ...credentials, username: "rear-fixture-viewer" }),
    ]);
    expect((await a.discover())[0]?.name).toBe("front-fixture");
    expect((await b.discover())[0]?.name).toBe("rear-fixture");
  });
  it("rejects a later cookie identity change instead of silently adopting it", async () => {
    let username = credentials.username;
    const f = fixture(() => json({ ...identity, username }));
    const a = f.make();
    await a.connect();
    username = "unexpected-fixture-user";
    await code(a.verify(), "configuration");
  });
  it("applies rate-limit cooldown to interactive TOTP submissions", async () => {
    const f = fixture((url) =>
      url.pathname.endsWith("/verify")
        ? json({}, 401)
        : url.pathname.endsWith("/totp")
          ? json({}, 429, { "Retry-After": "60" })
          : json({ totp_required: true, totp_token: "generated" }),
    );
    const a = f.make();
    await a.login(credentials);
    await code(a.completeTotp("generated", "123456"), "rate-limit", 429);
    const count = f.fetch.mock.calls.length;
    await code(a.completeTotp("generated", "123456"), "rate-limit", 429);
    expect(f.fetch).toHaveBeenCalledTimes(count);
  });
  it("does not use discovery failure as a reason to refresh or mutate a source", async () => {
    const f = fixture(() => json({}, 503));
    await code(f.make().discover(), "proxy", 503);
    expect(
      f.fetch.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET"),
    ).toBe(true);
  });
});

describe("identity-conflict cache invalidation", () => {
  it("blocks cached discovery and further media requests after an observed cookie identity change", async () => {
    let username = credentials.username;
    const f = fixture((url) =>
      url.pathname.endsWith("/verify")
        ? json({ ...identity, username })
        : json(page(["fixture"])),
    );
    const a = f.make();
    await a.connect();
    await a.discover();
    username = "different-fixture-viewer";
    await code(a.verify(), "configuration");
    const count = f.fetch.mock.calls.length;
    await code(a.discover(), "configuration");
    await code(
      a.authorizedFetch("go2rtc/api/frame.jpeg?src=fixture"),
      "configuration",
    );
    expect(f.fetch).toHaveBeenCalledTimes(count);
  });
});
