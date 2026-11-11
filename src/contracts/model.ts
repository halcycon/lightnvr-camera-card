import type { CardConfigV1, Transport } from "./config";
export type Knowledge = "allowed" | "denied" | "unknown";
export type Action =
  | "live.view"
  | "audio.listen"
  | "audio.talk"
  | "snapshot"
  | "ptz"
  | "recording"
  | "privacy"
  | "daynight"
  | "detection"
  | "refresh";
export interface CameraSummary {
  name: string;
  uuid?: string;
  sources: { main: string; sub?: string };
  status: "online" | "offline" | "disabled" | "unknown";
  privacy: boolean | "unknown";
  capabilities: Readonly<Partial<Record<Action, Knowledge>>>;
  backchannel: Knowledge;
  ptz: Knowledge;
  recording?: boolean;
  preferredTransport?: Transport;
}
/** Credentials stay in memory/config only; never diagnostics or localStorage. */
export interface Credentials {
  username: string;
  password: string;
}
export interface ServerProfile {
  baseUrl: string;
  go2rtcUrl: string;
  origin: string;
  sameOrigin: boolean;
  /** Normalized origin + pathname, never credentials. One identity per cookie scope. */
  sessionScope: string;
  auth: "session" | "basic";
  credentialStorage: "dashboard" | "session";
}
export type LoginResult =
  | { kind: "authenticated"; mustChangePassword: boolean; redirect?: string }
  | { kind: "totp-required"; challenge: string }
  | { kind: "password-change-required" };
export interface Identity {
  username: string;
  role?: string;
  mustChangePassword: boolean;
}
export interface ClientConfig {
  go2rtc: Knowledge;
  forceNativeHls: boolean | "unknown";
  audioDisabled: boolean | "unknown";
  transports: Readonly<Record<Transport, Knowledge>>;
  defaultTransport?: Transport;
  connectionTimeoutMs?: number;
  iceRecoveryMs?: number;
}
export type FailureCode =
  | "auth"
  | "policy"
  | "privacy"
  | "source-offline"
  | "unsupported-codec"
  | "unsupported-api"
  | "network"
  | "ice"
  | "timeout"
  | "buffer"
  | "cancelled"
  | "autoplay"
  | "configuration"
  | "proxy"
  | "rate-limit"
  | "password-change"
  | "totp";
export interface PlaybackFailure {
  code: FailureCode;
  message: string;
  status?: number;
  retryAfterMs?: number;
}
/** Safe fixed messages only; raw upstream text, SDP and URLs must never be copied. */
export class NvrError extends Error {
  constructor(readonly failure: PlaybackFailure) {
    super(failure.message);
    this.name = "NvrError";
  }
}
export interface SourceSelection {
  source: string;
  camera?: string;
  uuid?: string;
  profile: "main" | "sub";
}
export interface MediaUrls {
  webrtc: string;
  mse: string;
  go2rtcHls: string;
  nativeHls?: string;
  snapshot: string;
}
export interface RequestOptions {
  signal?: AbortSignal;
}
export interface PtzAxes {
  x?: number;
  y?: number;
  z?: number;
  speed?: number;
}
export type ControlRequest =
  | { action: "ptz"; command: "move" | "absolute" | "relative"; axes: PtzAxes }
  | { action: "ptz"; command: "stop" | "home" | "set-home" }
  | { action: "ptz"; command: "goto-preset" | "save-preset"; preset: string }
  | { action: "daynight"; mode: "auto" | "day" | "night" }
  | { action: "recording"; enabled: boolean }
  | { action: "privacy"; enabled: boolean }
  | { action: "refresh" };
export type ControlResult =
  { state: "applied" } | { state: "accepted"; status: 202 };
export interface ControlState {
  recording?: boolean;
  privacy?: boolean;
  daynight?: "auto" | "day" | "night";
  presets?: readonly { id: string; name: string }[];
  ptz?: Readonly<{ pan: boolean; tilt: boolean; zoom: boolean }>;
}
export interface Detection {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  confidence?: number;
}
export interface NvrClient {
  readonly profile: ServerProfile;
  connect(
    credentials?: Credentials,
    options?: RequestOptions,
  ): Promise<LoginResult>;
  login(
    credentials: Credentials,
    options?: RequestOptions,
  ): Promise<LoginResult>;
  completeTotp(
    challenge: string,
    code: string,
    options?: RequestOptions,
  ): Promise<LoginResult>;
  verify(options?: RequestOptions): Promise<Identity>;
  discover(options?: RequestOptions): Promise<readonly CameraSummary[]>;
  clientConfig(options?: RequestOptions): Promise<ClientConfig>;
  iceServers(options?: RequestOptions): Promise<readonly RTCIceServer[]>;
  /** Relative paths only. Reject redirects/out-of-scope HLS children. No raw go2rtc admin route. */
  authorizedFetch(path: string, init?: RequestInit): Promise<Response>;
  mediaUrls(source: SourceSelection, listen: boolean): MediaUrls;
  readControl(
    camera: string,
    action: Action,
    options?: RequestOptions,
  ): Promise<ControlState>;
  control(
    camera: string,
    request: ControlRequest,
    options?: RequestOptions,
  ): Promise<ControlResult>;
  detections(
    camera: string,
    options?: RequestOptions,
  ): Promise<readonly Detection[]>;
  dispose(): void;
}
export type NvrClientFactory = (config: CardConfigV1) => NvrClient;
