// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { LightNvrCameraCard } from "../../../src/card";
import "../../../src/index";
import { ViewerSession } from "../../../src/ui/session";
import { camera, config, deferred, fixture, flush } from "./fixture";
import { type NvrClient } from "../../../src/contracts";
Object.defineProperty(document, "fullscreenElement", {
  configurable: true,
  get: () => null,
});
afterEach(async () => {
  document.body.replaceChildren();
  await flush();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(options: Record<string, unknown> = {}, f = fixture()) {
  const card = document.createElement(
    "lightnvr-camera-card",
  ) as LightNvrCameraCard;
  card.viewerRuntime = f.runtime;
  card.setConfig(config(options));
  document.body.append(card);
  await flush();
  await card.updateComplete;
  return { card, ...f };
}
const button = (card: LightNvrCameraCard, label: string) =>
  [...card.shadowRoot!.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  )!;
const key = (
  target: EventTarget,
  type: string,
  value: string,
  repeat = false,
) =>
  target.dispatchEvent(
    new KeyboardEvent(type, {
      key: value,
      repeat,
      bubbles: true,
      cancelable: true,
    }),
  );
const pointer = (target: EventTarget, type: string, pointerId = 1) =>
  target.dispatchEvent(
    new PointerEvent(type, {
      pointerId,
      button: 0,
      bubbles: true,
      cancelable: true,
    }),
  );

describe("Home Assistant card lifecycle", () => {
  it("registers the custom card once and provides lazy editor helpers and Sections sizing", async () => {
    expect(customElements.get("lightnvr-camera-card")).toBe(LightNvrCameraCard);
    const cards = (
      window as unknown as Window & { customCards: { type: string }[] }
    ).customCards;
    expect(cards.filter((c) => c.type === "lightnvr-camera-card")).toHaveLength(
      1,
    );
    const { card } = await mount();
    expect(card.getCardSize()).toBeGreaterThan(1);
    expect(card.getGridOptions()).toEqual({
      columns: 12,
      rows: "auto",
      min_columns: 3,
    });
    expect((await LightNvrCameraCard.getConfigElement()).localName).toBe(
      "lightnvr-camera-card-editor",
    );
    expect((await LightNvrCameraCard.getStubConfig()).type).toBe(
      "custom:lightnvr-camera-card",
    );
  });
  it("rejects invalid config without echoing credentials", () => {
    const card = new LightNvrCameraCard();
    expect(() =>
      card.setConfig({ password: "PRIVATE", transports: [] }),
    ).toThrow("Invalid lightNVR card configuration");
    try {
      card.setConfig({ password: "PRIVATE" });
    } catch (error) {
      expect(String(error)).not.toContain("PRIVATE");
    }
  });
  it("does not restart on repeated hass updates or identical config", async () => {
    const { card, playback, client } = await mount();
    const video = card.shadowRoot!.querySelector("video");
    for (let i = 0; i < 100; i++) card.hass = { states: { generated: i } };
    card.setConfig(config());
    await flush();
    expect(playback.start).toHaveBeenCalledOnce();
    expect(client.connect).toHaveBeenCalledOnce();
    expect(card.shadowRoot!.querySelector("video")).toBe(video);
  });
  it("invalidates a pending login before configuring a replacement client", async () => {
    const first = fixture();
    const second = fixture(camera({ name: "next", sources: { main: "next" } }));
    const login = deferred<Awaited<ReturnType<NvrClient["connect"]>>>();
    vi.mocked(first.client.connect).mockReturnValue(login.promise);
    const factory = vi
      .fn()
      .mockReturnValueOnce(first.client)
      .mockReturnValue(second.client);
    const players = vi
      .fn()
      .mockReturnValueOnce(first.playback)
      .mockReturnValue(second.playback);
    const { card } = await mount(
      {},
      {
        ...first,
        runtime: { ...first.runtime, client: factory, playback: players },
      },
    );
    card.setConfig(config({ stream: "next" }));
    await flush();
    login.resolve({ kind: "authenticated", mustChangePassword: false });
    await flush();
    expect(first.client.dispose).toHaveBeenCalledOnce();
    expect(first.client.discover).not.toHaveBeenCalled();
    expect(first.playback.start).not.toHaveBeenCalled();
    expect(second.playback.start).toHaveBeenCalledOnce();
  });
  it("cancels pending media and unsubscribes before releasing the API reference", async () => {
    const f = fixture();
    const pending = deferred<void>();
    vi.mocked(f.playback.start).mockReturnValue(pending.promise);
    const { card } = await mount({}, f);
    const signal = vi.mocked(f.playback.start).mock.calls[0]![2]!;
    card.remove();
    await flush();
    expect(signal.aborted).toBe(true);
    expect(f.listeners).toBe(0);
    expect(f.playback.dispose).toHaveBeenCalledOnce();
    expect(f.client.dispose).toHaveBeenCalledOnce();
    pending.resolve();
    await flush();
    expect(f.playback.retry).not.toHaveBeenCalled();
  });
  it("reconnects a removed card using a fresh session", async () => {
    const first = fixture();
    const second = fixture();
    first.runtime.client = vi
      .fn()
      .mockReturnValueOnce(first.client)
      .mockReturnValue(second.client);
    first.runtime.playback = vi
      .fn()
      .mockReturnValueOnce(first.playback)
      .mockReturnValue(second.playback);
    const { card } = await mount({}, first);
    card.remove();
    await flush();
    document.body.append(card);
    await flush();
    expect(second.playback.start).toHaveBeenCalledOnce();
  });
  it("has independent video elements and scoped credential form IDs", async () => {
    const a = fixture(),
      b = fixture();
    vi.mocked(a.client.connect).mockResolvedValue({
      kind: "totp-required",
      challenge: "ephemeral-a",
    });
    vi.mocked(b.client.connect).mockResolvedValue({
      kind: "totp-required",
      challenge: "ephemeral-b",
    });
    const one = await mount({}, a),
      two = await mount({}, b);
    expect(one.card.shadowRoot!.querySelector("video")).not.toBe(
      two.card.shadowRoot!.querySelector("video"),
    );
    const id1 = one.card.shadowRoot!.querySelector("input")!.id,
      id2 = two.card.shadowRoot!.querySelector("input")!.id;
    expect(id1).not.toBe(id2);
    expect(one.card.shadowRoot!.querySelector("label")!.htmlFor).toBe(id1);
    expect(one.card.shadowRoot!.textContent).not.toContain("ephemeral");
  });
  it("renders configurable controls, default refresh off and explicit link requirement", async () => {
    const { card } = await mount({
      controls: {
        speaker: false,
        microphone: false,
        ptz: false,
        timeline: true,
      },
    });
    expect(button(card, "Listen")).toBeUndefined();
    expect(card.shadowRoot!.textContent).not.toContain("Hold to talk");
    expect(card.shadowRoot!.textContent).not.toContain(
      "Refresh source (all viewers)",
    );
    expect(card.shadowRoot!.querySelector("a")).toBeNull();
    expect(card.shadowRoot!.textContent).toContain("viewer_url");
  });
  it("preserves a literal camera source suffix and uses profile changes locally", async () => {
    const f = fixture(
      camera({
        name: "front_door_sub",
        sources: { main: "front_door_sub", sub: "verified_sub" },
      }),
    );
    const { card } = await mount({ stream: "front_door_sub" }, f);
    expect(vi.mocked(f.playback.start).mock.calls[0]![1].stream).toBe(
      "front_door_sub",
    );
    expect(f.client.control).not.toHaveBeenCalled();
    const select = card.shadowRoot!.querySelector<HTMLSelectElement>(
      '[aria-label="Source profile"]',
    )!;
    select.value = "sub";
    select.dispatchEvent(new Event("change"));
    await flush();
    expect(vi.mocked(f.playback.start).mock.calls.at(-1)![1].profile).toBe(
      "sub",
    );
    expect(f.client.control).not.toHaveBeenCalled();
  });
});

describe("interaction exits and accessibility", () => {
  const options = { audio: { microphone: true } };
  it("does not capture on mount and limits keyboard PTT to its focused control", async () => {
    vi.stubGlobal("isSecureContext", true);
    const { card, playback } = await mount(options);
    expect(playback.startTalk).not.toHaveBeenCalled();
    key(window, "keydown", " ");
    expect(playback.startTalk).not.toHaveBeenCalled();
    const mic = button(card, "Hold to talk");
    expect(mic.disabled).toBe(false);
    mic.focus();
    key(mic, "keydown", " ");
    key(mic, "keydown", " ", true);
    expect(playback.startTalk).toHaveBeenCalledOnce();
    const signal = vi.mocked(playback.startTalk).mock.calls[0]![0];
    key(window, "keyup", " ");
    expect(signal.aborted).toBe(true);
    expect(playback.stopTalk).toHaveBeenCalled();
  });
  it.each([
    "pointerup",
    "pointercancel",
    "lostpointercapture",
    "blur",
    "hidden",
    "escape",
    "disconnect",
    "reconfigure",
  ])("stops talk on %s including pending permission", async (exit) => {
    vi.stubGlobal("isSecureContext", true);
    const { card, playback } = await mount(options);
    const pending = deferred<void>();
    vi.mocked(playback.startTalk).mockReturnValue(pending.promise);
    const mic = button(card, "Hold to talk");
    pointer(mic, "pointerdown");
    const signal = vi.mocked(playback.startTalk).mock.calls[0]![0];
    if (exit === "hidden") {
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
    } else if (exit === "disconnect") card.remove();
    else if (exit === "reconfigure")
      card.setConfig(config({ ...options, title: "Changed" }));
    else if (exit === "escape") key(window, "keydown", "Escape");
    else if (exit === "blur") mic.dispatchEvent(new FocusEvent("blur"));
    else pointer(exit === "pointerup" ? window : mic, exit);
    expect(signal.aborted).toBe(true);
    pending.resolve();
    await flush();
    expect(playback.stopTalk).toHaveBeenCalled();
  });
  it("toggle release keeps talk active until next gesture; cancellation stops it", async () => {
    vi.stubGlobal("isSecureContext", true);
    const { card, playback, emit } = await mount({
      audio: { microphone: true, talk_mode: "toggle" },
    });
    const mic = button(card, "Toggle microphone");
    pointer(mic, "pointerdown");
    const signal = vi.mocked(playback.startTalk).mock.calls[0]![0];
    pointer(mic, "pointerup");
    expect(signal.aborted).toBe(false);
    emit({ talk: { active: true, pending: false }, talking: true });
    await flush();
    pointer(mic, "pointerdown");
    pointer(mic, "pointerup");
    expect(signal.aborted).toBe(true);
  });
  it("shows independent active mic and local level while speaker remains muted", async () => {
    vi.stubGlobal("isSecureContext", true);
    const { card, emit } = await mount(options);
    emit({ talk: { active: true, pending: false, level: 0.4 }, talking: true });
    await flush();
    await card.updateComplete;
    expect(card.shadowRoot!.textContent).toContain("Microphone active");
    expect(button(card, "Listen").getAttribute("aria-pressed")).toBe("false");
    expect(card.shadowRoot!.querySelector("meter")!.value).toBe(0.4);
  });
  it("stops talk and PTZ on hidden document even when playback continues", async () => {
    vi.stubGlobal("isSecureContext", true);
    const { card, client, playback } = await mount({
      ...options,
      playback_visibility: { hidden: "continue", offscreen: "continue" },
    });
    const up = button(card, "Up");
    pointer(up, "pointerdown");
    await flush();
    vi.mocked(playback.stopTalk).mockClear();
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(playback.stopTalk).toHaveBeenCalled();
    expect(client.control).toHaveBeenCalledWith("fixture", {
      action: "ptz",
      command: "stop",
    });
    expect(playback.setVisible).toHaveBeenLastCalledWith(true);
  });
  it("stops PTZ on keyboard release, blur, and transport transition", async () => {
    const { card, client, emit } = await mount();
    const up = button(card, "Up");
    key(up, "keydown", "Enter");
    key(window, "keyup", "Enter");
    await flush();
    expect(client.control).toHaveBeenCalledWith("fixture", {
      action: "ptz",
      command: "stop",
    });
    vi.mocked(client.control).mockClear();
    pointer(up, "pointerdown");
    emit({ transport: "hls" });
    await flush();
    expect(client.control).toHaveBeenCalledWith("fixture", {
      action: "ptz",
      command: "stop",
    });
  });
  it("disables unsupported talk with a readable explanation and known denied controls", async () => {
    vi.stubGlobal("isSecureContext", true);
    const f = fixture(
      camera({
        capabilities: { snapshot: "denied", recording: "denied" },
        backchannel: "denied",
      }),
    );
    const { card, playback } = await mount(options, f);
    expect(button(card, "Hold to talk").disabled).toBe(true);
    expect(button(card, "Snapshot").disabled).toBe(true);
    expect(card.shadowRoot!.textContent).toContain("backchannel");
    pointer(button(card, "Hold to talk"), "pointerdown");
    expect(playback.startTalk).not.toHaveBeenCalled();
  });
  it("clears poll state on lifecycle stop without recursive talk notifications", async () => {
    const f = fixture();
    const viewer = new ViewerSession(
      config(),
      document.createElement("video"),
      vi.fn(),
      f.runtime,
    );
    await viewer.start();
    f.emit({ state: "suspended" });
    f.emit({ talk: { active: false, pending: false } });
    expect(f.playback.stopTalk).toHaveBeenCalledTimes(2);
    await viewer.dispose();
  });
});

describe("local viewer actions", () => {
  it("keeps document visibility separate from offscreen pause policy with the real controller", async () => {
    const { createPlaybackController } = await import("../../../src/playback");
    const { createTalkController } = await import("../../../src/audio");
    vi.stubGlobal("RTCPeerConnection", class {});
    const adapter = {
      kind: "webrtc" as const,
      start: vi
        .fn()
        .mockImplementation(async (context) =>
          context.emit({ type: "first-frame", transport: "webrtc" }),
        ),
      stop: vi.fn().mockResolvedValue(undefined),
      setListening: vi.fn().mockResolvedValue(undefined),
    };
    const f = fixture();
    f.runtime.talk = createTalkController;
    f.runtime.playback = (dependencies) =>
      createPlaybackController({
        ...dependencies,
        createTransport: () => adapter,
      });
    const { card } = await mount(
      {
        transports: ["webrtc"],
        playback_visibility: { hidden: "continue", offscreen: "pause" },
      },
      f,
    );
    await flush();
    expect(card.shadowRoot!.textContent).toContain("playing");
    const starts = adapter.start.mock.calls.length;
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(adapter.start).toHaveBeenCalledTimes(starts);
    expect(adapter.stop).not.toHaveBeenCalled();
    card.remove();
    await flush();
    expect(adapter.stop).toHaveBeenCalled();
  });
  it("upgrades sub to main on fullscreen and restores the original profile after exit", async () => {
    const f = fixture();
    const { card } = await mount(
      { profile: "sub", layout: { fullscreen_main: true } },
      f,
    );
    const fullscreen = vi
      .spyOn(document, "fullscreenElement", "get")
      .mockReturnValue(card);
    document.dispatchEvent(new Event("fullscreenchange"));
    await flush();
    expect(vi.mocked(f.playback.start).mock.calls.at(-1)![1].profile).toBe(
      "main",
    );
    fullscreen.mockReturnValue(null);
    document.dispatchEvent(new Event("fullscreenchange"));
    await flush();
    expect(vi.mocked(f.playback.start).mock.calls.at(-1)![1].profile).toBe(
      "sub",
    );
    expect(f.client.control).not.toHaveBeenCalled();
  });
  it("restores sub on a failed fullscreen main upgrade without changing the server source", async () => {
    const f = fixture();
    const { card } = await mount(
      { profile: "sub", layout: { fullscreen_main: true } },
      f,
    );
    vi.spyOn(document, "fullscreenElement", "get").mockReturnValue(card);
    document.dispatchEvent(new Event("fullscreenchange"));
    await flush();
    f.emit({ state: "failed" });
    await flush();
    expect(vi.mocked(f.playback.start).mock.calls.at(-1)![1].profile).toBe(
      "sub",
    );
    expect(card.shadowRoot!.textContent).toContain(
      "returning to selected profile",
    );
    expect(f.client.control).not.toHaveBeenCalled();
  });
  it("keeps a manual exact source unchanged in fullscreen", async () => {
    const f = fixture();
    const { card } = await mount(
      {
        source: "front_door_sub",
        profile: "sub",
        layout: { fullscreen_main: true },
      },
      f,
    );
    vi.spyOn(document, "fullscreenElement", "get").mockReturnValue(card);
    document.dispatchEvent(new Event("fullscreenchange"));
    await flush();
    expect(f.playback.start).toHaveBeenCalledOnce();
    expect(vi.mocked(f.playback.start).mock.calls[0]![1].source).toBe(
      "front_door_sub",
    );
  });
  it("reports a missing fullscreen API without throwing", async () => {
    const { card } = await mount();
    Object.defineProperty(card, "requestFullscreen", { value: undefined });
    button(card, "Fullscreen").click();
    await flush();
    expect(card.shadowRoot!.textContent).toContain("Fullscreen is unavailable");
  });
  it("aligns normalized overlays with the source and escapes server labels", async () => {
    const f = fixture();
    vi.mocked(f.client.detections).mockResolvedValue([
      {
        x: 0.25,
        y: 0.5,
        width: 0.5,
        height: 0.25,
        label: "<script>unsafe</script>",
      },
    ]);
    const { card } = await mount({ layout: { object_fit: "cover" } }, f);
    const video = card.shadowRoot!.querySelector("video")!;
    Object.defineProperties(video, {
      videoWidth: { value: 640 },
      videoHeight: { value: 360 },
    });
    button(card, "Show detections").click();
    await flush();
    const svg = card.shadowRoot!.querySelector("svg")!,
      rect = svg.querySelector("rect")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 640 360");
    expect(svg.getAttribute("preserveAspectRatio")).toBe("xMidYMid slice");
    expect(rect.getAttribute("x")).toBe("160");
    expect(rect.getAttribute("height")).toBe("90");
    expect(svg.querySelector("script")).toBeNull();
  });
});

describe("serialized card retirement", () => {
  it("waits for the old API/player lifetime across multiple rapid config changes", async () => {
    const first = fixture();
    const second = fixture(
      camera({ name: "latest", sources: { main: "latest" } }),
    );
    const cleanup = deferred<void>();
    vi.mocked(first.playback.dispose).mockReturnValue(cleanup.promise);
    first.runtime.client = vi
      .fn()
      .mockReturnValueOnce(first.client)
      .mockReturnValue(second.client);
    first.runtime.playback = vi
      .fn()
      .mockReturnValueOnce(first.playback)
      .mockReturnValue(second.playback);
    const { card } = await mount({}, first);
    card.setConfig(config({ stream: "intermediate" }));
    card.setConfig(config({ stream: "latest" }));
    await flush();
    expect(first.runtime.client).toHaveBeenCalledOnce();
    expect(first.client.dispose).not.toHaveBeenCalled();
    expect(second.playback.start).not.toHaveBeenCalled();
    cleanup.resolve();
    await flush();
    expect(first.client.dispose).toHaveBeenCalledOnce();
    expect(second.playback.start).toHaveBeenCalledOnce();
    expect(vi.mocked(second.playback.start).mock.calls[0]![1].stream).toBe(
      "latest",
    );
  });
});

describe("timeline navigation", () => {
  it("renders the canonical-camera timeline and refreshes local time at the click", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 10, 10, 7, 8, 9));
      const { card } = await mount({
        viewer_url: "https://viewer.example.test/web/root/",
        source: "rtsp://private.invalid/raw",
      });
      const link = card.shadowRoot!.querySelector("a")!;
      expect(link.textContent).toBe("Open camera timeline in lightNVR");
      expect(new URL(link.href).searchParams.get("stream")).toBe("fixture");
      vi.setSystemTime(new Date(2026, 10, 10, 9, 10, 11));
      vi.spyOn(document, "fullscreenElement", "get").mockReturnValue(card);
      link.addEventListener("click", (event) => event.preventDefault());
      link.click();
      const url = new URL(link.href);
      expect(url.pathname).toBe("/web/root/timeline.html");
      expect(url.searchParams.get("time")).toBe("09:10:11");
      expect(url.searchParams.get("fullscreen")).toBe("1");
      expect(link.href).not.toContain("private.invalid");
      card.remove();
      await flush();
    } finally {
      vi.useRealTimers();
    }
  });
  it("renders an explicit root-only link for a manual source without canonical identity", async () => {
    const f = fixture();
    vi.mocked(f.client.discover).mockResolvedValue([]);
    const { card } = await mount(
      {
        viewer_url: "https://viewer.example.test/web/",
        stream: "manual",
        source: "rtsp://private.invalid/raw",
      },
      f,
    );
    const link = card.shadowRoot!.querySelector("a")!;
    expect(link.textContent).toBe("Open lightNVR");
    expect(link.href).toBe("https://viewer.example.test/web/");
  });
});

describe("fullscreen upgrade failure boundaries", () => {
  it("restores sub exactly once for an offline main source without retrying or mutating the server", async () => {
    const f = fixture();
    const { card } = await mount(
      { profile: "sub", layout: { fullscreen_main: true } },
      f,
    );
    vi.spyOn(document, "fullscreenElement", "get").mockReturnValue(card);
    document.dispatchEvent(new Event("fullscreenchange"));
    await flush();
    expect(f.playback.start).toHaveBeenCalledTimes(2);
    f.emit({
      state: "offline",
      failure: { code: "source-offline", message: "Source is offline." },
    });
    await flush();
    expect(f.playback.start).toHaveBeenCalledTimes(3);
    expect(vi.mocked(f.playback.start).mock.calls.at(-1)![1].profile).toBe(
      "sub",
    );
    f.emit({
      state: "offline",
      failure: { code: "source-offline", message: "Source is offline." },
    });
    await flush();
    expect(f.playback.start).toHaveBeenCalledTimes(3);
    expect(f.playback.retry).not.toHaveBeenCalled();
    expect(f.client.control).not.toHaveBeenCalled();
  });
  it.each([
    ["auth-required", "auth"],
    ["auth-required", "password-change"],
    ["auth-required", "totp"],
    ["denied", "policy"],
    ["denied", "privacy"],
    ["failed", "privacy"],
    ["offline", "policy"],
    ["offline", "auth"],
  ] as const)(
    "does not restore a profile around %s / %s",
    async (state, code) => {
      const f = fixture();
      const { card } = await mount(
        { profile: "sub", layout: { fullscreen_main: true } },
        f,
      );
      vi.spyOn(document, "fullscreenElement", "get").mockReturnValue(card);
      document.dispatchEvent(new Event("fullscreenchange"));
      await flush();
      f.emit({
        state,
        failure: { code, message: "Terminal authorization/privacy decision." },
      });
      await flush();
      expect(f.playback.start).toHaveBeenCalledTimes(2);
      expect(vi.mocked(f.playback.start).mock.calls.at(-1)![1].profile).toBe(
        "main",
      );
      expect(f.playback.retry).not.toHaveBeenCalled();
      expect(f.client.control).not.toHaveBeenCalled();
    },
  );
});
