import { createNvrClient, safeDiagnostic, selectSource } from "../api";
import { createPlaybackController } from "../playback";
import { createTalkController } from "../audio";
import { createWebRtcAdapter } from "../transports/webrtc";
import { createMseAdapter } from "../transports/mse";
import { createHlsAdapter } from "../transports/hls";
import {
  NvrError,
  type Action,
  type CameraSummary,
  type CardConfigV1,
  type ClientConfig,
  type ControlRequest,
  type ControlResult,
  type ControlState,
  type Credentials,
  type Detection,
  type NvrClient,
  type NvrClientFactory,
  type PlaybackController,
  type PlaybackDependencies,
  type PlaybackSnapshot,
  type PtzAxes,
  type SourceSelection,
} from "../contracts";
import {
  availability,
  canvasSnapshot,
  readSnapshot,
  scaledAxes,
} from "./controls";

export interface ViewerRuntime {
  client: NvrClientFactory;
  playback: (dependencies: PlaybackDependencies) => PlaybackController;
  talk: typeof createTalkController;
}
export const defaultRuntime: ViewerRuntime = {
  client: createNvrClient,
  playback: createPlaybackController,
  talk: createTalkController,
};
const initial = (): PlaybackSnapshot => ({
  state: "idle",
  attempt: 0,
  talking: false,
  talk: { active: false, pending: false },
});
/** One lifetime per mounted configuration. API auth and raw media remain in their typed implementations. */
export class ViewerSession {
  readonly abort = new AbortController();
  readonly client: NvrClient;
  readonly playback: PlaybackController;
  snapshot = initial();
  camera: CameraSummary | undefined;
  caps: ClientConfig | undefined;
  source: SourceSelection | undefined;
  message = "";
  fallbackReason = "";
  auth: "credentials" | "totp" | "password-change" | undefined;
  private challenge = "";
  readonly denied = new Set<Action>();
  controlState: ControlState = {};
  busy = false;
  listening: boolean;
  detectionEnabled = false;
  detections: readonly Detection[] = [];
  private visible = true;
  private playbackVisible = true;
  private startRevision = 0;
  authBusy = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private pollAbort: AbortController | undefined;
  private gesture: AbortController | undefined;
  private ptz:
    { moving: Promise<unknown>; camera: string; released: boolean } | undefined;
  private unsubscribe: () => void;
  private ptzCleanup = new Set<Promise<unknown>>();
  private moveAborts = new Set<AbortController>();
  private disposal: Promise<void> | undefined;
  constructor(
    readonly config: CardConfigV1,
    readonly video: HTMLVideoElement,
    private changed: () => void,
    runtime = defaultRuntime,
  ) {
    this.listening =
      config.audio.enabled && config.audio.listen && !config.audio.muted;
    this.client = runtime.client(config);
    this.playback = runtime.playback({
      client: this.client,
      talk: runtime.talk(),
      createTransport: (kind) =>
        kind === "webrtc"
          ? createWebRtcAdapter()
          : kind === "mse"
            ? createMseAdapter()
            : createHlsAdapter(),
    });
    this.unsubscribe = this.playback.subscribe((snapshot) => {
      const previous = this.snapshot;
      this.snapshot = snapshot;
      if (snapshot.failure) this.fallbackReason = snapshot.failure.message;
      if (snapshot.state === "auth-required")
        this.auth =
          snapshot.failure?.code === "password-change"
            ? "password-change"
            : "credentials";
      if (snapshot.failure?.code === "privacy") {
        this.controlState = { ...this.controlState, privacy: true };
        this.detections = [];
      }
      if (
        previous.transport !== snapshot.transport ||
        (previous.state === "playing" && snapshot.state !== "playing")
      )
        this.stopInteractions();
      if (snapshot.state !== "playing") this.stopPolling();
      else this.poll();
      this.changed();
    });
  }
  get alive(): boolean {
    return !this.abort.signal.aborted;
  }
  private fail(error: unknown, action?: Action): void {
    if (!this.alive) return;
    const safe = safeDiagnostic(error);
    if (
      action &&
      (safe.code === "policy" || safe.status === 401 || safe.status === 403)
    )
      this.denied.add(action);
    this.message = safe.message;
    this.changed();
  }
  async start(credentials?: Credentials, otp?: string): Promise<void> {
    const revision = ++this.startRevision;
    this.authBusy = true;
    this.changed();
    const current = () => this.alive && revision === this.startRevision;
    try {
      const options = { signal: this.abort.signal };
      const result =
        otp && this.challenge
          ? await this.client.completeTotp(this.challenge, otp, options)
          : await this.client.connect(credentials, options);
      if (!current()) return;
      if (result.kind !== "authenticated" || result.mustChangePassword) {
        this.auth =
          result.kind === "totp-required" ? "totp" : "password-change";
        if (result.kind === "totp-required") this.challenge = result.challenge;
        this.changed();
        return;
      }
      this.auth = undefined;
      this.challenge = "";
      const [inventory, caps] = await Promise.all([
        this.client.discover(options),
        this.client.clientConfig(options),
      ]);
      if (!current()) return;
      this.source = selectSource(this.config, inventory);
      this.camera = inventory.find((c) => c.name === this.source?.camera);
      this.caps = caps;
      this.changed();
      await this.playback.start(this.video, this.config, this.abort.signal);
      if (current()) await this.playback.setVisible(this.playbackVisible);
    } catch (error) {
      if (!current()) return;
      if (safeDiagnostic(error).code === "auth") this.auth = "credentials";
      this.fail(error);
    } finally {
      if (current()) {
        this.authBusy = false;
        this.changed();
      }
    }
  }
  async speaker(): Promise<void> {
    const enabled = !this.listening;
    try {
      await this.playback.setListening(enabled);
      if (this.alive) {
        this.listening = enabled;
        this.changed();
      }
    } catch (error) {
      this.fail(error, "audio.listen");
    }
  }
  startTalk(): void {
    if (!this.alive || this.gesture) return;
    const gesture = new AbortController();
    this.gesture = gesture;
    void this.playback.startTalk(gesture.signal).catch((error) => {
      if (this.gesture !== gesture) return;
      this.gesture = undefined;
      gesture.abort();
      this.fail(error, "audio.talk");
    });
  }
  stopTalk(): void {
    this.gesture?.abort();
    this.gesture = undefined;
    void this.playback.stopTalk().catch(() => {});
  }
  stopInteractions(): void {
    this.stopTalk();
    this.stopPtz();
  }
  setVisible(visible: boolean, playbackVisible = visible): void {
    this.visible = visible;
    this.playbackVisible = playbackVisible;
    if (!visible) {
      this.stopInteractions();
      this.stopPolling();
    } else this.poll();
    void this.playback
      .setVisible(playbackVisible)
      .catch((error) => this.fail(error));
  }
  get privateCamera(): boolean {
    return (this.controlState.privacy ?? this.camera?.privacy) === true;
  }
  private permitted(action: Action): boolean {
    if (
      this.privateCamera &&
      (action === "snapshot" || action === "detection")
    ) {
      this.message = "Camera privacy is enabled.";
      this.changed();
      return false;
    }
    const access = availability(
      action,
      this.camera
        ? {
            ...this.camera,
            privacy: this.controlState.privacy ?? this.camera.privacy,
          }
        : undefined,
      this.denied,
    );
    if (!access.enabled) {
      this.message = access.reason;
      this.changed();
    }
    return access.enabled && this.alive;
  }
  async read(action: Action): Promise<void> {
    if (!this.permitted(action)) return;
    try {
      const state = await this.client.readControl(this.camera!.name, action, {
        signal: this.abort.signal,
      });
      if (this.alive) {
        this.controlState = { ...this.controlState, ...state };
        this.changed();
      }
    } catch (error) {
      this.fail(error, action);
    }
  }
  /** Shared-effect controls only run after an explicit per-action confirmation. */
  async mutate(
    request: ControlRequest,
    confirm: (message: string) => boolean = (message) =>
      window.confirm(message),
  ): Promise<void> {
    if (
      this.busy ||
      (request.action === "ptz" && this.ptzCleanup.size > 0) ||
      !this.permitted(request.action)
    )
      return;
    this.stopInteractions();
    const shared =
      request.action !== "ptz" ||
      request.command === "set-home" ||
      request.command === "save-preset";
    if (
      shared &&
      !confirm(
        `${request.action === "refresh" ? "Refresh source" : request.action}: affects this camera and other viewers. Continue?`,
      )
    )
      return;
    this.busy = true;
    this.changed();
    try {
      // Never infer recording/privacy state from a 202 or a button caption.
      if (request.action === "recording" || request.action === "privacy") {
        const state = await this.client.readControl(
          this.camera!.name,
          request.action,
          { signal: this.abort.signal },
        );
        const current =
          request.action === "recording" ? state.recording : state.privacy;
        if (typeof current !== "boolean")
          throw new NvrError({ code: "unsupported-api", message: "" });
        request = { action: request.action, enabled: !current };
        if (request.action === "privacy") {
          this.controlState = { ...this.controlState, privacy: true };
          this.stopPolling();
          this.detections = [];
          this.stopInteractions();
          await this.playback.stop();
        }
      }
      if (!this.alive) return;
      const result =
        request.action === "ptz" &&
        (request.command === "home" || request.command === "goto-preset")
          ? await this.motion(request)
          : await this.client.control(this.camera!.name, request, {
              signal: this.abort.signal,
            });
      if (!this.alive) return;
      this.message =
        result.state === "accepted"
          ? "Request accepted; active state is not yet confirmed."
          : "Request applied.";
      if (
        request.action === "privacy" ||
        request.action === "recording" ||
        request.action === "daynight" ||
        request.action === "ptz"
      ) {
        const state = await this.client.readControl(
          this.camera!.name,
          request.action,
          { signal: this.abort.signal },
        );
        if (!this.alive) return;
        this.controlState = { ...this.controlState, ...state };
        if (request.action === "privacy") {
          // Do not resume ambiguous or private media. Resume requires an explicit local retry.
          if (state.privacy !== false) {
            this.stopInteractions();
            await this.playback.stop();
          }
        }
      }
    } catch (error) {
      if (request.action === "privacy") {
        this.stopInteractions();
        void this.playback.stop();
      }
      this.fail(error, request.action);
    } finally {
      if (this.alive) {
        this.busy = false;
        this.changed();
      }
    }
  }
  private trackPtz(work: Promise<unknown>): void {
    this.ptzCleanup.add(work);
    void work.finally(() => this.ptzCleanup.delete(work)).catch(() => {});
  }
  private motion(request: ControlRequest): Promise<ControlResult> {
    const camera = this.camera!.name;
    const abort = new AbortController();
    this.moveAborts.add(abort);
    const moving = this.client.control(camera, request, {
      signal: abort.signal,
    });
    const hold = { moving, camera, released: false };
    this.ptz = hold;
    const cleanup = moving
      .catch((error) => this.fail(error, "ptz"))
      .then(async () => {
        if (hold.released)
          await this.client
            .control(camera, { action: "ptz", command: "stop" })
            .catch(() => {});
      })
      .finally(() => this.moveAborts.delete(abort));
    this.trackPtz(cleanup);
    return moving;
  }
  startPtz(axes: PtzAxes, speed: number): void {
    if (this.ptz || this.ptzCleanup.size || !this.permitted("ptz")) return;
    // Keep motion alive through release/removal until final stop, bounded by dispose.
    void this.motion({
      action: "ptz",
      command: "move",
      axes: scaledAxes(axes, speed),
    }).catch(() => {});
  }
  emergencyStop(): void {
    this.stopTalk();
    if (this.ptz) this.stopPtz();
    else if (this.permitted("ptz"))
      this.trackPtz(
        this.client
          .control(this.camera!.name, { action: "ptz", command: "stop" })
          .catch((error) => this.fail(error, "ptz")),
      );
  }
  stopPtz(): void {
    const hold = this.ptz;
    if (!hold) return;
    this.ptz = undefined;
    hold.released = true;
    this.trackPtz(
      this.client
        .control(hold.camera, { action: "ptz", command: "stop" })
        .catch((error) => this.fail(error, "ptz")),
    );
  }
  toggleDetections(): void {
    if (!this.permitted("detection")) return;
    this.detectionEnabled = !this.detectionEnabled;
    if (this.detectionEnabled) this.poll();
    else {
      this.stopPolling();
      this.detections = [];
    }
    this.changed();
  }
  private stopPolling(): void {
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.pollAbort?.abort();
    this.pollAbort = undefined;
  }
  private poll(): void {
    if (
      this.pollTimer ||
      this.pollAbort ||
      !this.alive ||
      !this.visible ||
      this.privateCamera ||
      !this.detectionEnabled ||
      this.snapshot.state !== "playing" ||
      !this.camera ||
      this.denied.has("detection")
    )
      return;
    const abort = new AbortController();
    this.pollAbort = abort;
    void this.client
      .detections(this.camera.name, { signal: abort.signal })
      .then((detections) => {
        if (this.alive && !this.privateCamera && !abort.signal.aborted) {
          this.detections = detections.slice(0, 100);
          this.changed();
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted) {
          this.fail(error, "detection");
          this.detectionEnabled = false;
          this.detections = [];
        }
      })
      .finally(() => {
        if (this.pollAbort !== abort) return;
        this.pollAbort = undefined;
        if (this.alive && this.visible && this.detectionEnabled)
          this.pollTimer = setTimeout(() => {
            this.pollTimer = undefined;
            this.poll();
          }, 1000);
      });
  }
  async snapshotBlob(
    local = () => canvasSnapshot(this.video),
  ): Promise<Blob | undefined> {
    if (!this.permitted("snapshot") || !this.source) return;
    try {
      const url = new URL(
        this.client.mediaUrls(this.source, this.config.audio.listen).snapshot,
      );
      const base = new URL(this.client.profile.baseUrl);
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
        throw new NvrError({ code: "configuration", message: "" });
      try {
        const response = await this.client.authorizedFetch(
          url.href.slice(base.href.length),
          { signal: this.abort.signal },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new NvrError({
            code:
              response.status === 401
                ? "auth"
                : response.status === 403
                  ? "policy"
                  : "unsupported-api",
            status: response.status,
            message: "",
          });
        }
        if (
          !/^image\/(jpeg|png)(;|$)/i.test(
            response.headers.get("Content-Type") ?? "",
          )
        ) {
          await response.body?.cancel();
          throw new NvrError({ code: "unsupported-api", message: "" });
        }
        const blob = await readSnapshot(response, this.abort.signal);
        return this.alive && !this.privateCamera ? blob : undefined;
      } catch (error) {
        const safe = safeDiagnostic(error);
        if (
          this.privateCamera ||
          !this.alive ||
          safe.code !== "unsupported-api" ||
          ![404, 405, 501].includes(safe.status ?? 0) ||
          this.camera?.capabilities.snapshot !== "allowed"
        )
          throw error;
        try {
          const blob = await local();
          return this.alive && !this.privateCamera ? blob : undefined;
        } catch {
          if (this.alive) {
            this.message =
              "Local snapshot unavailable: no decoded frame, unavailable canvas, or browser origin policy.";
            this.changed();
          }
          return undefined;
        }
      }
    } catch (error) {
      this.fail(error, "snapshot");
      return undefined;
    }
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.stopInteractions();
    this.stopPolling();
    this.abort.abort();
    this.unsubscribe();
    this.disposal = (async () => {
      // Client must remain usable for a final stop after a delayed move acknowledgment.
      let timer: ReturnType<typeof setTimeout> | undefined;
      // oxlint-disable-next-line unicorn/no-useless-spread -- Capture a fixed batch of pending stops for bounded disposal.
      const cleanup = Promise.all([...this.ptzCleanup]).catch(() => {});
      await Promise.all([
        this.playback.dispose().catch(() => {}),
        Promise.race([
          cleanup,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 2000);
          }),
        ]),
      ]);
      clearTimeout(timer);
      this.moveAborts.forEach((abort) => abort.abort());
      this.moveAborts.clear();
      this.client.dispose();
    })();
    return this.disposal;
  }
}
