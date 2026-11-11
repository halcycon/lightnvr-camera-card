import type {
  CameraSummary,
  CardConfigV1,
  Knowledge,
  Transport,
  SourceSelection,
  StreamSummaryWire,
} from "../contracts";
import { failure } from "./safety";
export const knowledge = (value: unknown): Knowledge =>
  value === true ? "allowed" : value === false ? "denied" : "unknown";
const preferences: Readonly<Record<string, Transport>> = {
  webrtc_only: "webrtc",
  mse_only: "mse",
  hls_only: "hls",
  webrtc_then_mse: "webrtc",
  mse_then_hls: "mse",
};
/** Frozen summaries hold a first renderer, not an entire upstream fallback policy. */
export const transportPreference = (
  policy: string | undefined,
): Transport | undefined => preferences[policy ?? ""];
export function mapCamera(wire: StreamSummaryWire): CameraSummary {
  const status = wire.status?.toLowerCase();
  // Configured card transport order remains authoritative.
  const preferredTransport = transportPreference(wire.playback_transport);
  return {
    name: wire.name,
    ...(wire.camera_uuid === undefined ? {} : { uuid: wire.camera_uuid }),
    sources: {
      main: wire.name,
      ...(wire.has_sub_stream === true ? { sub: `${wire.name}_sub` } : {}),
    },
    status:
      wire.enabled === false
        ? "disabled"
        : status === "running" || status === "online"
          ? "online"
          : status === "offline" || status === "error" || status === "stopped"
            ? "offline"
            : "unknown",
    privacy: wire.privacy_mode ?? "unknown",
    // Hardware flags establish absence only; hardware availability is not an action grant.
    capabilities: {
      "live.view": wire.streaming_enabled === false ? "denied" : "allowed",
      "audio.listen": "unknown",
      "audio.talk": wire.backchannel_enabled === false ? "denied" : "unknown",
      ptz: wire.ptz_enabled === false ? "denied" : "unknown",
      privacy: knowledge(wire.can_control_privacy),
      snapshot: "unknown",
      recording: "unknown",
      daynight: "unknown",
      detection: "unknown",
      refresh: "unknown",
    },
    backchannel: knowledge(wire.backchannel_enabled),
    ptz: knowledge(wire.ptz_enabled),
    ...(wire.recording_active === undefined
      ? {}
      : { recording: wire.recording_active }),
    ...(preferredTransport ? { preferredTransport } : {}),
  };
}
/** Exact manual source never implies a camera identity or suffix removal. */
export function selectSource(
  config: Pick<CardConfigV1, "stream" | "source" | "camera_uuid" | "profile">,
  inventory: readonly CameraSummary[],
): SourceSelection {
  const camera = config.camera_uuid
    ? inventory.find((c) => c.uuid === config.camera_uuid)
    : inventory.find((c) => c.name === config.stream);
  if (config.source !== undefined)
    return {
      source: config.source,
      profile: config.profile,
      ...(camera
        ? { camera: camera.name, ...(camera.uuid ? { uuid: camera.uuid } : {}) }
        : {}),
    };
  if (!camera) throw failure("configuration");
  const source = camera.sources[config.profile];
  if (!source) throw failure("configuration");
  return {
    source,
    camera: camera.name,
    profile: config.profile,
    ...(camera.uuid ? { uuid: camera.uuid } : {}),
  };
}
