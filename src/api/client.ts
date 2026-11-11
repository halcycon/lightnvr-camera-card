import { z } from "zod";
import {
  NvrError,
  loginResponseSchema,
  streamPageSchema,
  type NvrClient,
  type NvrClientFactory,
  type CardConfigV1,
  type Credentials,
  type ServerProfile,
  type LoginResult,
  type Identity,
  type RequestOptions,
  type CameraSummary,
  type ClientConfig,
  type SourceSelection,
  type MediaUrls,
  type Action,
  type ControlRequest,
  type ControlResult,
  type ControlState,
  type Detection,
} from "../contracts";
import {
  basicHeader,
  cameraPath,
  hasControlCharacters,
  failure,
  normalizeProfile,
  scopedUrl,
  throwIfAborted,
} from "./safety";
import { knowledge, mapCamera, transportPreference } from "./mapping";

interface Memo {
  value: unknown;
  expires: number;
}
interface Scope {
  refs: number;
  requestedIdentity?: string;
  credentials?: Credentials;
  identity?: string;
  auth?: Promise<LoginResult>;
  challenge?: string;
  epoch: number;
  blockedUntil: number;
  memo: Map<string, Memo>;
  controller: AbortController;
  authenticatedUntil: number;
  conflicted: boolean;
  cookieGateway: boolean;
}
export interface ClientRuntime {
  fetch?: typeof fetch;
  documentUrl?: string;
  requestTimeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
}
const controlSuccessSchema = z.object({ success: z.literal(true) });
const identitySchema = z.object({
  authenticated: z.literal(true),
  username: z.string().min(1),
  role: z.string().optional(),
  must_change_password: z.boolean().optional(),
});
const configSchema = z.object({
  go2rtc_enabled: z.boolean().optional(),
  go2rtc_available: z.boolean().optional(),
  go2rtc_force_native_hls: z.boolean().optional(),
  audio_disabled: z.boolean().optional(),
  webrtc_disabled: z.boolean().optional(),
  mse_disabled: z.boolean().optional(),
  hls_disabled: z.boolean().optional(),
  default_playback_transport: z.string().optional(),
  webrtc_connection_timeout_ms: z
    .number()
    .finite()
    .min(100)
    .max(300000)
    .optional(),
  webrtc_ice_recovery_timeout_ms: z
    .number()
    .finite()
    .min(0)
    .max(300000)
    .optional(),
});
const iceSchema = z.object({
  ice_servers: z
    .array(
      z.object({
        urls: z.union([z.string(), z.array(z.string()).min(1)]),
        username: z.string().optional(),
        credential: z.string().optional(),
      }),
    )
    .max(32),
});
const detectionSchema = z.object({
  detections: z.array(
    z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().finite().nonnegative(),
      height: z.number().finite().nonnegative(),
      label: z.string(),
      confidence: z.number().finite().optional(),
    }),
  ),
});
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value;
}
/** Registry holds credentials only while referenced. No media resources are shared. */
export function createClientFactory(
  runtime: ClientRuntime = {},
): NvrClientFactory {
  const scopes = new Map<string, Scope>();
  const fetcher = runtime.fetch ?? globalThis.fetch.bind(globalThis);
  const now = runtime.now ?? Date.now;
  const timeout = Math.max(
    100,
    Math.min(runtime.requestTimeoutMs ?? 10000, 60000),
  );
  const ttl = Math.max(0, Math.min(runtime.cacheTtlMs ?? 30000, 60000));
  return (config) => {
    const profile = normalizeProfile(config, runtime.documentUrl);
    // Basic uses no cookie, and can safely coexist with a session identity.
    const key = `${profile.sessionScope}|${profile.auth}`;
    let scope = scopes.get(key);
    if (!scope) {
      scope = {
        refs: 0,
        epoch: 0,
        blockedUntil: 0,
        memo: new Map(),
        controller: new AbortController(),
        authenticatedUntil: 0,
        conflicted: false,
        cookieGateway: false,
      };
      scopes.set(key, scope);
    }
    scope.refs++;
    const release = () => {
      if (--scope.refs === 0) {
        scope.controller.abort();
        scope.memo.clear();
        delete scope.credentials;
        delete scope.challenge;
        scopes.delete(key);
      }
    };
    try {
      return new Client(
        config,
        profile,
        scope,
        fetcher,
        now,
        timeout,
        ttl,
        release,
      );
    } catch (error) {
      release();
      throw error;
    }
  };
}

class Client implements NvrClient {
  private disposed = false;
  private lifetime = new AbortController();
  constructor(
    private config: CardConfigV1,
    readonly profile: ServerProfile,
    private scope: Scope,
    private fetcher: typeof fetch,
    private now: () => number,
    private timeout: number,
    private ttl: number,
    private release: () => void,
  ) {
    if (scope.conflicted) throw failure("configuration");
    if (config.username !== undefined) {
      if (
        (scope.requestedIdentity &&
          scope.requestedIdentity !== config.username) ||
        (scope.identity && scope.identity !== config.username)
      )
        throw failure("configuration");
      scope.requestedIdentity = config.username;
    }
    if (config.username !== undefined && config.password !== undefined)
      this.claim({ username: config.username, password: config.password });
  }
  private alive(signal?: AbortSignal): void {
    if (this.disposed) throw failure("cancelled");
    throwIfAborted(signal);
    if (this.scope.conflicted) throw failure("configuration");
  }
  private async wait<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      this.alive(signal);
    } catch (error) {
      void work.catch(() => {});
      throw error;
    }
    const combined = signal
      ? AbortSignal.any([signal, this.lifetime.signal])
      : this.lifetime.signal;
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(failure("cancelled"));
      combined.addEventListener("abort", abort, { once: true });
      work
        .then((value) => {
          if (combined.aborted) reject(failure("cancelled"));
          else resolve(value);
        }, reject)
        .finally(() => combined.removeEventListener("abort", abort));
    });
  }
  private claim(credentials: Credentials): void {
    this.alive();
    if (!credentials.username || typeof credentials.password !== "string")
      throw failure("configuration");
    const s = this.scope;
    if (
      (s.requestedIdentity && s.requestedIdentity !== credentials.username) ||
      (s.identity && s.identity !== credentials.username) ||
      (s.credentials && s.credentials.username !== credentials.username)
    )
      throw failure("configuration");
    if (s.credentials && s.credentials.password !== credentials.password) {
      if (s.refs > 1 || s.auth) throw failure("configuration");
      s.controller.abort();
      s.controller = new AbortController();
      s.memo.clear();
      delete s.challenge;
      s.authenticatedUntil = 0;
      s.epoch++;
    }
    s.requestedIdentity = credentials.username;
    s.credentials = { ...credentials };
  }
  async connect(
    credentials?: Credentials,
    options: RequestOptions = {},
  ): Promise<LoginResult> {
    this.alive(options.signal);
    const supplied =
      credentials ??
      (this.config.username !== undefined && this.config.password !== undefined
        ? { username: this.config.username, password: this.config.password }
        : undefined);
    if (supplied) return this.login(supplied, options);
    const identity = await this.verify(options);
    return identity.mustChangePassword
      ? { kind: "password-change-required" }
      : { kind: "authenticated", mustChangePassword: false };
  }
  async login(
    credentials: Credentials,
    options: RequestOptions = {},
  ): Promise<LoginResult> {
    this.alive(options.signal);
    this.claim(credentials);
    return this.wait(this.authenticate(), options.signal);
  }
  private authenticate(force = false): Promise<LoginResult> {
    const s = this.scope;
    if (s.auth) return s.auth;
    if (!force && s.challenge)
      return Promise.resolve({ kind: "totp-required", challenge: s.challenge });
    if (!force && s.authenticatedUntil > this.now())
      return Promise.resolve({
        kind: "authenticated",
        mustChangePassword: false,
      });
    if (s.blockedUntil > this.now())
      return Promise.reject(
        failure("rate-limit", 429, s.blockedUntil - this.now()),
      );
    const work = async (): Promise<LoginResult> => {
      if (!s.credentials) throw failure("auth");
      if (this.profile.auth === "basic") {
        const identity = await this.verifyShared();
        s.epoch++;
        s.memo.clear();
        s.authenticatedUntil = identity.mustChangePassword
          ? 0
          : this.now() + this.ttl;
        return identity.mustChangePassword
          ? { kind: "password-change-required" }
          : { kind: "authenticated", mustChangePassword: false };
      }
      // Check the existing cookie before login: another identity must not be replaced.
      try {
        await this.verifyShared();
      } catch (error) {
        if (!(error instanceof NvrError) || error.failure.code !== "auth")
          throw error;
      }
      const result = await this.json(
        "api/auth/login",
        loginResponseSchema,
        {
          method: "POST",
          body: JSON.stringify(s.credentials),
          headers: { "Content-Type": "application/json" },
        },
        true,
      );
      return this.applyLogin(result);
    };
    s.auth = work().finally(() => {
      delete s.auth;
    });
    return s.auth;
  }
  private applyLogin(data: z.infer<typeof loginResponseSchema>): LoginResult {
    const s = this.scope;
    s.memo.clear();
    s.epoch++;
    if ("totp_required" in data) {
      s.challenge = data.totp_token;
      return { kind: "totp-required", challenge: data.totp_token };
    }
    delete s.challenge;
    if (s.credentials) s.identity = s.credentials.username;
    s.authenticatedUntil = data.must_change_password
      ? 0
      : this.now() + this.ttl;
    return data.must_change_password
      ? { kind: "password-change-required" }
      : { kind: "authenticated", mustChangePassword: false };
  }
  async completeTotp(
    challenge: string,
    code: string,
    options: RequestOptions = {},
  ): Promise<LoginResult> {
    this.alive(options.signal);
    if (this.scope.blockedUntil > this.now())
      throw failure("rate-limit", 429, this.scope.blockedUntil - this.now());
    if (
      this.profile.auth !== "session" ||
      challenge !== this.scope.challenge ||
      !/^\d{6}$/.test(code)
    )
      throw failure("totp");
    if (this.scope.auth) return this.wait(this.scope.auth, options.signal);
    const work = this.json(
      "api/auth/login/totp",
      loginResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({ totp_token: challenge, code }),
        headers: { "Content-Type": "application/json" },
      },
      true,
    ).then((value) => this.applyLogin(value));
    this.scope.auth = work.finally(() => {
      delete this.scope.auth;
    });
    return this.wait(this.scope.auth, options.signal);
  }
  private async verifyShared(): Promise<Identity> {
    const wire = await this.json("api/auth/verify", identitySchema, {}, true);
    const s = this.scope;
    if (
      (s.requestedIdentity && s.requestedIdentity !== wire.username) ||
      (s.identity && s.identity !== wire.username) ||
      (s.credentials && s.credentials.username !== wire.username)
    ) {
      s.conflicted = true;
      s.memo.clear();
      s.controller.abort();
      throw failure("configuration");
    }
    s.identity = wire.username;
    return {
      username: wire.username,
      mustChangePassword: wire.must_change_password ?? false,
      ...(wire.role ? { role: wire.role } : {}),
    };
  }
  async verify(options: RequestOptions = {}): Promise<Identity> {
    this.alive(options.signal);
    return this.wait(this.verifyShared(), options.signal);
  }
  cookieMediaAllowed(): boolean {
    return (
      this.profile.auth === "session" &&
      (this.profile.sameOrigin || this.scope.cookieGateway)
    );
  }
  private async raw(
    path: string,
    init: RequestInit = {},
    shared = false,
  ): Promise<Response> {
    if (!shared) this.alive(init.signal ?? undefined);
    if (this.scope.conflicted) throw failure("configuration");
    const url = scopedUrl(this.profile, path);
    const headers = new Headers(init.headers);
    headers.delete("Authorization");
    headers.delete("Cookie");
    if (this.profile.auth === "basic") {
      if (!this.profile.sameOrigin) throw failure("configuration");
      const credentials = this.scope.credentials;
      if (!credentials) throw failure("auth");
      headers.set(
        "Authorization",
        basicHeader(credentials.username, credentials.password),
      );
    }
    const deadline = new AbortController();
    const signals = [deadline.signal, this.scope.controller.signal];
    if (!shared) signals.push(this.lifetime.signal);
    if (init.signal) signals.push(init.signal);
    const signal = AbortSignal.any(signals);
    const timer = setTimeout(() => deadline.abort(), this.timeout);
    const cleanup = () => clearTimeout(timer);
    const reason = () =>
      failure(deadline.signal.aborted ? "timeout" : "cancelled");
    try {
      throwIfAborted(signal);
      const response = await this.fetcher(url.href, {
        ...init,
        headers,
        signal,
        credentials: this.profile.auth === "basic" ? "omit" : "include",
        cache: "no-store",
        redirect: "error",
      });
      if (signal.aborted) {
        await response.body?.cancel().catch(() => {});
        throw reason();
      }
      if (response.redirected || (response.url && response.url !== url.href)) {
        await response.body?.cancel().catch(() => {});
        throw failure("proxy");
      }
      // CORS must expose this exact opt-in marker. It describes browser cookie
      // transport, never camera permissions; authenticated discovery still follows.
      if (
        url.protocol === "https:" &&
        this.profile.auth === "session" &&
        response.headers.get("X-LightNVR-Card-Gateway") ===
          "same-site-session-v1"
      )
        this.scope.cookieGateway = true;
      if (!response.body) {
        cleanup();
        return response;
      }
      // Keep deadline and caller cancellation through body consumption, not just headers.
      const reader = response.body.getReader();
      const abort = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      const finish = () => {
        cleanup();
        signal.removeEventListener("abort", abort);
      };
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const result = await reader.read();
              if (signal.aborted) throw reason();
              if (result.done) {
                finish();
                controller.close();
              } else controller.enqueue(result.value);
            } catch {
              finish();
              controller.error(signal.aborted ? reason() : failure("network"));
            }
          },
          async cancel() {
            finish();
            await reader.cancel().catch(() => {});
          },
        }),
        { status: response.status, statusText: "", headers: response.headers },
      );
    } catch (error) {
      cleanup();
      if (signal.aborted) throw reason();
      if (error instanceof NvrError) throw error;
      throw failure("network");
    }
  }
  private async check(response: Response, path = ""): Promise<Response> {
    if (response.ok) return response;
    const status = response.status;
    if (status === 401 || status === 403) this.scope.memo.clear();
    const goPrefix = new URL(this.profile.go2rtcUrl).pathname.slice(
      new URL(this.profile.baseUrl).pathname.length,
    );
    // Only known go2rtc media connectivity errors affect source backoff. Never classify a denial from body text.
    if (
      status >= 500 &&
      path.startsWith(goPrefix) &&
      !/text\/html/i.test(response.headers.get("Content-Type") ?? "")
    ) {
      const reader = response.body?.getReader();
      let body = "";
      let size = 0;
      const decoder = new TextDecoder();
      try {
        while (reader && size < 4096) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const bounded = chunk.value.subarray(0, 4096 - size);
          size += bounded.byteLength;
          body += decoder.decode(bounded, { stream: true });
        }
      } finally {
        await reader?.cancel().catch(() => {});
      }
      if (
        /dial tcp|no route to host|connection refused|connect: network is unreachable/i.test(
          body,
        )
      )
        throw failure("source-offline", status);
    } else await response.body?.cancel().catch(() => {});
    if (status === 429) {
      const header = response.headers.get("Retry-After");
      const seconds = header === null ? NaN : Number(header);
      const retry = Number.isFinite(seconds)
        ? seconds * 1000
        : header
          ? Date.parse(header) - this.now()
          : 30000;
      const delay = Math.max(
        1000,
        Math.min(Number.isFinite(retry) ? retry : 30000, 300000),
      );
      this.scope.blockedUntil = this.now() + delay;
      throw failure("rate-limit", status, delay);
    }
    throw failure(
      status === 401
        ? "auth"
        : status === 403
          ? "policy"
          : status === 423
            ? "auth"
            : status === 404 || status === 405
              ? "unsupported-api"
              : status >= 500
                ? "proxy"
                : "unsupported-api",
      status,
    );
  }
  private async request(
    path: string,
    init: RequestInit = {},
    shared = false,
  ): Promise<Response> {
    const epoch = this.scope.epoch;
    let response = await this.raw(path, init, shared);
    // Replay only safe reads, once. Commands may have applied and are never retried.
    if (
      response.status === 401 &&
      this.scope.credentials &&
      !this.scope.challenge &&
      (init.method ?? "GET") === "GET"
    ) {
      await response.body?.cancel().catch(() => {});
      if (epoch === this.scope.epoch) {
        const result = await this.wait(
          this.authenticate(true),
          init.signal ?? undefined,
        );
        if (result.kind !== "authenticated")
          throw failure(
            result.kind === "totp-required" ? "totp" : "password-change",
          );
      }
      response = await this.raw(path, init, shared);
    }
    return this.check(response, path);
  }
  private async json<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
    auth = false,
    shared = true,
  ): Promise<T> {
    const response = auth
      ? await this.check(await this.raw(path, init, true))
      : await this.request(path, init, shared);
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get("Content-Type") ?? "",
      )
    ) {
      await response.body?.cancel().catch(() => {});
      throw failure("unsupported-api", response.status);
    }
    try {
      const value: unknown = await response.json();
      throwIfAborted(init.signal ?? undefined);
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw failure("unsupported-api", response.status);
      return parsed.data;
    } catch (error) {
      if (error instanceof NvrError) throw error;
      throw failure("unsupported-api", response.status);
    }
  }
  private async cached<T>(
    key: string,
    load: () => Promise<T>,
    options: RequestOptions,
  ): Promise<T> {
    this.alive(options.signal);
    const memo = this.scope.memo.get(key);
    if (memo && memo.expires > this.now()) return memo.value as T;
    const epoch = this.scope.epoch;
    const result = await this.wait(load(), options.signal);
    this.alive(options.signal);
    if (epoch === this.scope.epoch)
      this.scope.memo.set(key, {
        value: immutable(result),
        expires: this.now() + this.ttl,
      });
    return result;
  }
  discover(options: RequestOptions = {}): Promise<readonly CameraSummary[]> {
    return this.cached(
      "inventory",
      async () => {
        const cameras: CameraSummary[] = [];
        const names = new Set<string>();
        let pages = 1;
        for (let page = 1; page <= pages; page++) {
          this.alive(options.signal);
          const query = new URLSearchParams({
            summary: "true",
            surface: "live",
            page: String(page),
            page_size: "100",
            sort_by: "name",
            sort_order: "asc",
            availability: "all",
          });
          const data = await this.json(
            `api/streams?${query}`,
            streamPageSchema,
            options.signal ? { signal: options.signal } : {},
            false,
            false,
          );
          if (
            data.page !== page ||
            data.total_pages > 10000 ||
            (data.total_pages === 0 && data.streams.length !== 0)
          )
            throw failure("unsupported-api");
          if (page === 1) pages = data.total_pages;
          else if (data.total_pages !== pages) throw failure("unsupported-api");
          for (const wire of data.streams) {
            if (names.has(wire.name)) throw failure("unsupported-api");
            names.add(wire.name);
            cameras.push(mapCamera(wire));
          }
        }
        return cameras;
      },
      options,
    );
  }
  clientConfig(options: RequestOptions = {}): Promise<ClientConfig> {
    return this.cached(
      "config",
      async () => {
        const data = await this.json(
          "api/client-config",
          configSchema,
          options.signal ? { signal: options.signal } : {},
          false,
          false,
        );
        const go2rtc =
          data.go2rtc_enabled === false || data.go2rtc_available === false
            ? "denied"
            : data.go2rtc_enabled === true && data.go2rtc_available === true
              ? "allowed"
              : "unknown";
        const disabled = (value: boolean | undefined) =>
          value === undefined ? "unknown" : knowledge(!value);
        const preferred = transportPreference(data.default_playback_transport);
        return {
          go2rtc,
          forceNativeHls: data.go2rtc_force_native_hls ?? "unknown",
          audioDisabled: data.audio_disabled ?? "unknown",
          transports: {
            webrtc:
              go2rtc === "denied" ? "denied" : disabled(data.webrtc_disabled),
            mse: go2rtc === "denied" ? "denied" : disabled(data.mse_disabled),
            hls: disabled(data.hls_disabled),
          },
          ...(preferred ? { defaultTransport: preferred } : {}),
          ...(data.webrtc_connection_timeout_ms === undefined
            ? {}
            : { connectionTimeoutMs: data.webrtc_connection_timeout_ms }),
          ...(data.webrtc_ice_recovery_timeout_ms === undefined
            ? {}
            : { iceRecoveryMs: data.webrtc_ice_recovery_timeout_ms }),
        };
      },
      options,
    );
  }
  async iceServers(
    options: RequestOptions = {},
  ): Promise<readonly RTCIceServer[]> {
    this.alive(options.signal);
    const data = await this.json(
      "api/ice-servers",
      iceSchema,
      options.signal ? { signal: options.signal } : {},
      false,
      false,
    );
    if (
      data.ice_servers.some((s) =>
        (Array.isArray(s.urls) ? s.urls : [s.urls]).some(
          (url) => !/^(stun|stuns|turn|turns):[^\s]+$/.test(url),
        ),
      )
    )
      throw failure("unsupported-api");
    return data.ice_servers.map((s) => ({
      urls: s.urls,
      ...(s.username === undefined ? {} : { username: s.username }),
      ...(s.credential === undefined ? {} : { credential: s.credential }),
    }));
  }
  async authorizedFetch(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const url = scopedUrl(this.profile, path);
    const relative = url.pathname.slice(
      new URL(this.profile.baseUrl).pathname.length,
    );
    const media = new URL(this.profile.go2rtcUrl).pathname.slice(
      new URL(this.profile.baseUrl).pathname.length,
    );
    // Never expose the go2rtc source registry, config, or arbitrary administration proxy.
    const goMedia = relative.slice(media.length);
    const allowedGo =
      relative.startsWith(media) &&
      (/^api\/(webrtc|frame\.jpeg|stream\.m3u8)$/.test(goMedia) ||
        /^api\/hls\/(playlist\.m3u8|init\.mp4|segment\.ts|segment\.m4s)$/.test(
          goMedia,
        ));
    if (
      !allowedGo &&
      !/^hls\/[a-zA-Z0-9_%.-]+\/[a-zA-Z0-9_.-]+$/.test(relative)
    )
      throw failure("configuration");
    const method = init.method ?? "GET";
    if (method !== "GET" && !(goMedia === "api/webrtc" && method === "POST"))
      throw failure("configuration");
    return this.request(path, init);
  }
  mediaUrls(source: SourceSelection, listen: boolean): MediaUrls {
    this.alive();
    if (!source.source || hasControlCharacters(source.source))
      throw failure("configuration");
    const params = new URLSearchParams({ src: source.source });
    const make = (path: string) =>
      new URL(path, this.profile.go2rtcUrl).href + "?" + params;
    const ws = new URL(make("api/ws"));
    ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
    const hls = new URL(make("api/stream.m3u8"));
    hls.searchParams.set("mp4", "flac");
    if (!listen) hls.searchParams.set("video", ""); // A sole video selector requests no audio media.
    return {
      webrtc: make("api/webrtc"),
      mse: ws.href,
      go2rtcHls: hls.href,
      snapshot: make("api/frame.jpeg"),
      ...(listen &&
      source.camera &&
      source.profile === "main" &&
      source.source === source.camera
        ? {
            nativeHls: new URL(
              `hls/${encodeURIComponent(source.camera)}/index.m3u8`,
              this.profile.baseUrl,
            ).href,
          }
        : {}),
    };
  }
  async readControl(
    camera: string,
    action: Action,
    options: RequestOptions = {},
  ): Promise<ControlState> {
    this.alive(options.signal);
    const base = cameraPath(camera);
    const init = options.signal ? { signal: options.signal } : {};
    if (action === "recording") {
      const value = await this.json(
        `${base}/recording`,
        z.object({ recording_active: z.boolean() }),
        init,
        false,
        false,
      );
      return { recording: value.recording_active };
    }
    if (action === "privacy") {
      const value = await this.json(
        base,
        z.object({ privacy_mode: z.boolean() }),
        init,
        false,
        false,
      );
      return { privacy: value.privacy_mode };
    }
    if (action === "daynight") {
      const value = await this.json(
        `${base}/daynight`,
        z.object({ mode: z.enum(["auto", "day", "night", "unknown"]) }),
        init,
        false,
        false,
      );
      return value.mode === "unknown" ? {} : { daynight: value.mode };
    }
    if (action === "ptz") {
      const caps = await this.json(
        `${base}/ptz/capabilities`,
        z.object({ has_pan_tilt: z.boolean(), has_zoom: z.boolean() }),
        init,
        false,
        false,
      );
      const presets = await this.json(
        `${base}/ptz/presets`,
        z.object({
          presets: z.array(z.object({ token: z.string(), name: z.string() })),
        }),
        init,
        false,
        false,
      );
      return {
        ptz: {
          pan: caps.has_pan_tilt,
          tilt: caps.has_pan_tilt,
          zoom: caps.has_zoom,
        },
        presets: presets.presets.map((p) => ({ id: p.token, name: p.name })),
      };
    }
    throw failure("unsupported-api");
  }
  async control(
    camera: string,
    request: ControlRequest,
    options: RequestOptions = {},
  ): Promise<ControlResult> {
    this.alive(options.signal);
    const base = cameraPath(camera);
    let path = base;
    let body: unknown = {};
    let method = "POST";
    let expected = 200;
    switch (request.action) {
      case "recording":
        path += "/recording";
        body = { action: request.enabled ? "start" : "stop" };
        expected = request.enabled ? 202 : 200;
        break;
      case "privacy":
        method = "PUT";
        body = { set_privacy_mode: request.enabled };
        break;
      case "refresh":
        path += "/refresh";
        expected = 202;
        break;
      case "daynight":
        path += "/daynight";
        body = { mode: request.mode };
        break;
      case "ptz":
        if (
          ["move", "absolute", "relative"].includes(request.command) &&
          "axes" in request
        ) {
          if (request.axes.speed !== undefined) throw failure("configuration"); // No speed field in the upstream wire API.
          const axes = {
            pan: request.axes.x,
            tilt: request.axes.y,
            zoom: request.axes.z,
          };
          const present = Object.values(axes).filter((v) => v !== undefined);
          if (
            !present.length ||
            present.some(
              (v) =>
                !Number.isFinite(v) || Math.abs(v!) > 3.4028234663852886e38,
            )
          )
            throw failure("configuration");
          path += `/ptz/${request.command}`;
          body = axes;
        } else if (
          request.command === "goto-preset" ||
          request.command === "save-preset"
        ) {
          if (!request.preset || request.preset.length > 63)
            throw failure("configuration");
          const save = request.command === "save-preset";
          path += save ? "/ptz/preset" : "/ptz/goto-preset";
          method = save ? "PUT" : "POST";
          body = save ? { name: request.preset } : { token: request.preset };
        } else if (["stop", "home", "set-home"].includes(request.command))
          path += `/ptz/${request.command}`;
        else throw failure("configuration");
        break;
      default:
        throw failure("configuration");
    }
    const response = await this.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status !== expected) {
      await response.body?.cancel().catch(() => {});
      throw failure("unsupported-api", response.status);
    }
    // Never interpret an acknowledgement as a confirmed recording state.
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get("Content-Type") ?? "",
      )
    ) {
      await response.body?.cancel().catch(() => {});
      throw failure("unsupported-api", response.status);
    }
    try {
      const value: unknown = await response.json();
      if (!controlSuccessSchema.safeParse(value).success)
        throw failure("unsupported-api", response.status);
    } catch (error) {
      if (error instanceof NvrError) throw error;
      throw failure("unsupported-api", response.status);
    }
    this.scope.memo.clear();
    return expected === 202
      ? { state: "accepted", status: 202 }
      : { state: "applied" };
  }
  async detections(
    camera: string,
    options: RequestOptions = {},
  ): Promise<readonly Detection[]> {
    this.alive(options.signal);
    cameraPath(camera);
    const value = await this.json(
      `api/detection/results/${encodeURIComponent(camera)}`,
      detectionSchema,
      options.signal ? { signal: options.signal } : {},
      false,
      false,
    );
    return value.detections.map((d) => ({
      x: d.x,
      y: d.y,
      width: d.width,
      height: d.height,
      label: d.label,
      ...(d.confidence === undefined ? {} : { confidence: d.confidence }),
    }));
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.release();
  }
}
/** Default module registry shares only authentication and short-lived metadata. */
export const createNvrClient: NvrClientFactory = createClientFactory();
