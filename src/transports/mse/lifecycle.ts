import type { TransportStart, Transport, FailureCode } from "../../contracts";
import { failure, safeDiagnostic } from "../../api/safety";

/** Shared by the two receive-only fallback transports. Each start owns one scope. */
export class MediaLifetime {
  readonly abort = new AbortController();
  private cleanups: (() => void)[] = [];
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private frame: number | undefined;
  private ended = false;
  private rendered = false;
  private blocked = false;
  constructor(
    readonly context: TransportStart,
    readonly kind: Transport,
    private readonly opaqueMediaErrors = false,
  ) {
    const { video, signal, config, capabilities } = context;
    const timeout =
      config.timeouts[`${kind}_ms`] ??
      (config.timeouts.connection_ms === "inherit"
        ? (capabilities.connectionTimeoutMs ?? 30000)
        : config.timeouts.connection_ms);
    this.deadline = setTimeout(() => this.fail("timeout"), timeout);
    this.on(signal, "abort", () => this.close());
    video.muted = !canListen(context) || config.audio.muted;
    video.volume = config.audio.volume;
    video.playsInline = true;
    // Native HLS conceals HTTP status: an apparent media error may be a denial.
    this.on(video, "error", () =>
      this.fail(
        this.opaqueMediaErrors
          ? "policy"
          : video.error?.code === 4
            ? "unsupported-codec"
            : "network",
      ),
    );
    const first = () => {
      if (
        !this.alive ||
        this.rendered ||
        video.videoWidth <= 0 ||
        video.readyState < 2
      )
        return;
      this.rendered = true;
      this.clearDeadline();
      context.emit({ type: "first-frame", transport: kind });
    };
    if (typeof video.requestVideoFrameCallback === "function") {
      const next = () => {
        if (!this.alive || this.rendered) return;
        this.frame = video.requestVideoFrameCallback(() => {
          this.frame = undefined;
          first();
          next();
        });
      };
      next();
    } else {
      // loadeddata alone does not establish presentation. Require advancing decoded playback.
      const baseline = video.currentTime;
      this.on(video, "timeupdate", () => {
        if (!video.paused && video.currentTime > baseline) first();
      });
    }
    if (signal.aborted) this.close();
  }
  get alive(): boolean {
    return !this.ended;
  }
  own(cleanup: () => void): void {
    if (this.ended) cleanup();
    else this.cleanups.push(cleanup);
  }
  on(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener);
    this.own(() => target.removeEventListener(type, listener));
  }
  clearDeadline(): void {
    clearTimeout(this.deadline);
    this.deadline = undefined;
  }
  async play(): Promise<void> {
    if (!this.alive) return;
    try {
      await this.context.video.play();
    } catch (error) {
      if (!this.alive) return;
      if (error instanceof Error && error.name === "NotAllowedError") {
        this.clearDeadline();
        if (!this.blocked) {
          this.blocked = true;
          this.context.emit({
            type: "failure",
            failure: failure("autoplay").failure,
          });
        }
      } else this.fail(this.opaqueMediaErrors ? "policy" : "network");
    }
  }
  fail(code: FailureCode, status?: number): void {
    this.failWith(failure(code, status));
  }
  failWith(error: unknown): void {
    if (!this.alive) return;
    const diagnostic = safeDiagnostic(error);
    this.close();
    this.context.emit({ type: "failure", failure: diagnostic });
  }
  close(): void {
    if (!this.alive) return;
    this.ended = true;
    this.clearDeadline();
    this.abort.abort();
    const { video } = this.context;
    if (this.frame !== undefined) video.cancelVideoFrameCallback(this.frame);
    this.frame = undefined;
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch {
        /* Continue disposing remaining owned resources. */
      }
    }
    video.pause();
    video.srcObject = null;
    video.removeAttribute("src");
    video.load();
  }
}
export function canListen(c: TransportStart): boolean {
  return (
    c.config.audio.enabled &&
    c.config.audio.listen &&
    c.capabilities.audioDisabled !== true &&
    c.camera?.capabilities["audio.listen"] !== "denied"
  );
}
export function checkPolicy(c: TransportStart, kind: Transport): void {
  if (c.signal.aborted) throw failure("cancelled");
  if (c.camera?.privacy === true) throw failure("privacy");
  if (
    c.camera?.capabilities["live.view"] === "denied" ||
    c.capabilities.transports[kind] === "denied"
  )
    throw failure("policy");
  if (c.camera?.status === "offline" || c.camera?.status === "disabled")
    throw failure("source-offline");
}
