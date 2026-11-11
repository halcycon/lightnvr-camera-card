import Hls from "hls.js";
import type { ClientConfig, NvrClient, Transport } from "../contracts";

/** Only known exclusions: unknown browser/server support is left to the adapter. */
export function transportAvailable(
  kind: Transport,
  capabilities: ClientConfig,
  client: NvrClient,
  video: HTMLVideoElement,
): boolean {
  if (capabilities.transports[kind] === "denied") return false;
  if (kind !== "hls" && capabilities.go2rtc === "denied") return false;
  if (
    kind === "mse" &&
    (!client.profile.sameOrigin || client.profile.auth !== "session")
  )
    return false;
  if (typeof window === "undefined") return true;
  if (kind === "webrtc") return typeof RTCPeerConnection === "function";
  if (kind === "mse")
    return (
      typeof MediaSource === "function" || "ManagedMediaSource" in globalThis
    );
  return (
    !!video.canPlayType("application/vnd.apple.mpegurl") || Hls.isSupported()
  );
}
