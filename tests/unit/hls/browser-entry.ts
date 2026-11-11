import { createMseAdapter } from "../../../src/transports/mse";
import { createHlsAdapter } from "../../../src/transports/hls";
import { createClientFactory } from "../../../src/api";
import {
  validateConfig,
  type TransportAdapter,
  type TransportEvent,
} from "../../../src/contracts";

let adapter: TransportAdapter | undefined;
let disposeClient: (() => void) | undefined;
const state: {
  events: TransportEvent[];
  urlCreates: number;
  urlRevokes: number;
} = { events: [], urlCreates: 0, urlRevokes: 0 };
export async function start(kind: "mse" | "hls") {
  await stop();
  state.events = [];
  const config = validateConfig({
    type: "custom:lightnvr-camera-card",
    server: "/nvr/front/",
    stream: "generated",
    timeouts: { connection_ms: 10000 },
  });
  const client = createClientFactory({ documentUrl: location.href })(config);
  disposeClient = () => client.dispose();
  const video = document.querySelector("video")!;
  adapter =
    kind === "mse"
      ? createMseAdapter({
          createObjectURL: (source) => {
            state.urlCreates++;
            return URL.createObjectURL(source);
          },
          revokeObjectURL: (url) => {
            state.urlRevokes++;
            URL.revokeObjectURL(url);
          },
        })
      : createHlsAdapter();
  await adapter.start({
    config,
    client,
    video,
    source: { source: "generated", camera: "generated", profile: "main" },
    capabilities: {
      go2rtc: "allowed",
      forceNativeHls: false,
      audioDisabled: false,
      transports: { mse: "allowed", hls: "allowed", webrtc: "allowed" },
    },
    signal: new AbortController().signal,
    emit: (event) => state.events.push(event),
  });
}
export async function stop() {
  await adapter?.stop();
  adapter = undefined;
  disposeClient?.();
  disposeClient = undefined;
}
export async function listen() {
  await adapter?.setListening(true);
}
export function snapshot() {
  const video = document.querySelector("video")!;
  return {
    ...state,
    width: video.videoWidth,
    height: video.videoHeight,
    muted: video.muted,
    time: video.currentTime,
    src: video.getAttribute("src"),
    hasSourceObject: video.srcObject !== null,
    audioDecodedBytes:
      (video as HTMLVideoElement & { webkitAudioDecodedByteCount?: number })
        .webkitAudioDecodedByteCount ?? 0,
  };
}
