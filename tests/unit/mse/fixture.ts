import { vi } from "vitest";
import {
  validateConfig,
  type TransportStart,
  type TransportEvent,
  type NvrClient,
} from "../../../src/contracts";

export class FakeVideo extends EventTarget {
  muted = true;
  volume = 1;
  playsInline = false;
  src = "";
  srcObject: unknown = null;
  currentTime = 0;
  videoWidth = 0;
  readyState = 0;
  paused = false;
  disableRemotePlayback = false;
  crossOrigin: string | null = null;
  error: { code: number } | null = null;
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  load = vi.fn();
  canPlayType = vi.fn(() => "");
  removeAttribute = vi.fn((name: string) => {
    if (name === "src") this.src = "";
  });
  private callback: VideoFrameRequestCallback | undefined;
  requestVideoFrameCallback = vi.fn((callback: VideoFrameRequestCallback) => {
    this.callback = callback;
    return 1;
  });
  cancelVideoFrameCallback = vi.fn(() => {
    this.callback = undefined;
  });
  frame() {
    this.videoWidth = 320;
    this.readyState = 2;
    this.callback?.(0, {} as VideoFrameCallbackMetadata);
  }
}
export class FakeBuffer extends EventTarget {
  updating = false;
  mode = "segments";
  ranges: [number, number][] = [];
  get buffered() {
    const ranges = this.ranges;
    return {
      get length() {
        return ranges.length;
      },
      start: (n: number) => ranges[n]![0],
      end: (n: number) => ranges[n]![1],
    };
  }
  appendBuffer = vi.fn((_data: ArrayBuffer) => {
    void _data;
    this.updating = true;
  });
  remove = vi.fn((_start: number, end: number) => {
    this.ranges = this.ranges.map((r) => [Math.max(r[0], end), r[1]]);
    this.updating = true;
  });
  abort = vi.fn(() => {
    this.updating = false;
  });
  done() {
    this.updating = false;
    this.dispatchEvent(new Event("updateend"));
  }
}
export class FakeSource extends EventTarget {
  static instances: FakeSource[] = [];
  static isTypeSupported = vi.fn((_mime: string) => {
    void _mime;
    return true;
  });
  readyState = "closed";
  buffer = new FakeBuffer();
  addSourceBuffer = vi.fn((_mime: string) => {
    void _mime;
    return this.buffer as unknown as SourceBuffer;
  });
  removeSourceBuffer = vi.fn();
  constructor() {
    super();
    FakeSource.instances.push(this);
  }
  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("sourceopen"));
  }
}
export class FakeSocket extends EventTarget {
  readyState = 0;
  binaryType = "";
  send = vi.fn();
  close = vi.fn();
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
export function fixture(extra: Record<string, unknown> = {}) {
  const config = validateConfig({
    type: "custom:lightnvr-camera-card",
    server: "/nvr/front/",
    stream: "generated",
    ...extra,
  });
  const video = new FakeVideo(),
    abort = new AbortController(),
    events: TransportEvent[] = [];
  const base = "https://dashboard.example.invalid/nvr/front/";
  const authorizedFetch = vi.fn<NvrClient["authorizedFetch"]>(
    async () => new Response("#EXTM3U\n"),
  );
  const client = {
    profile: {
      baseUrl: base,
      go2rtcUrl: base + "go2rtc/",
      origin: new URL(base).origin,
      sameOrigin: true,
      auth: "session",
    },
    authorizedFetch,
    mediaUrls: vi.fn((source, listen) => ({
      mse:
        base.replace("https:", "wss:") +
        "go2rtc/api/ws?src=" +
        encodeURIComponent(source.source),
      go2rtcHls:
        base +
        "go2rtc/api/stream.m3u8?src=" +
        encodeURIComponent(source.source) +
        "&mp4=flac" +
        (listen ? "" : "&video="),
      ...(listen &&
      source.camera &&
      source.profile === "main" &&
      source.source === source.camera
        ? { nativeHls: base + `hls/${source.camera}/index.m3u8` }
        : {}),
    })),
  } as unknown as NvrClient;
  const context: TransportStart = {
    video: video as unknown as HTMLVideoElement,
    source: { source: "generated", camera: "generated", profile: "main" },
    client,
    config,
    capabilities: {
      go2rtc: "allowed",
      forceNativeHls: false,
      audioDisabled: false,
      transports: { mse: "allowed", hls: "allowed", webrtc: "allowed" },
    },
    signal: abort.signal,
    emit: (e) => events.push(e),
  };
  return { context, video, abort, events, authorizedFetch };
}
