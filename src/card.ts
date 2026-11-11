import { LitElement, html, nothing } from "lit";
import {
  HA_METADATA_KEYS,
  stripHaMetadata,
  validateConfig,
  type Action,
  type CardConfigV1,
  type PtzAxes,
} from "./contracts";
import { availability, audioAvailability, timelineLink } from "./ui/controls";
import {
  ViewerSession,
  defaultRuntime,
  type ViewerRuntime,
} from "./ui/session";
import { viewerStyles } from "./ui/styles";
import { toolbarIcon, type ToolbarIcon } from "./ui/icons";

function withHaMetadata(
  effective: CardConfigV1,
  stored: CardConfigV1,
): CardConfigV1 {
  return {
    ...stripHaMetadata(effective),
    ...Object.fromEntries(
      HA_METADATA_KEYS.filter((key) => Object.hasOwn(stored, key)).map(
        (key) => [key, stored[key]],
      ),
    ),
  };
}

let cardSequence = 0;
export class LightNvrCameraCard extends LitElement {
  static styles = viewerStyles;
  static async getConfigElement(): Promise<HTMLElement> {
    return (await import("./editor")).createEditorElement();
  }
  static async getStubConfig(): Promise<CardConfigV1> {
    return (await import("./editor")).getStubConfig();
  }
  private config: CardConfigV1 | undefined;
  private configured: CardConfigV1 | undefined;
  private runtime = defaultRuntime;
  private session: ViewerSession | undefined;
  private revision = 0;
  private teardown = Promise.resolve();
  private observer: IntersectionObserver | undefined;
  private offscreen = false;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private speed = 0.5;
  private preset = "";
  private presetName = "";
  private fullscreenRestore: CardConfigV1 | undefined;
  private upgradeFailed = false;
  private notice = "";
  private advancedOpen = false;
  private downloadTimer: ReturnType<typeof setTimeout> | undefined;
  private downloadUrl = "";
  private inputOwner:
    { kind: "talk" | "ptz"; pointer?: number; key?: string } | undefined;
  private readonly scope = `lightnvr-${++cardSequence}`;
  // HA changes this on every entity update; this viewer has no HA entity subscriptions.
  set hass(_value: unknown) {
    /* Deliberately does not restart, render, or retain HA state. */
  }
  getCardSize(): number {
    return 6;
  }
  getGridOptions(): { columns: number; rows: "auto"; min_columns: number } {
    return { columns: 12, rows: "auto", min_columns: 3 };
  }
  /** Injectable typed factories for isolated hosts/tests, before mounting. */
  set viewerRuntime(runtime: ViewerRuntime) {
    this.runtime = runtime;
    this.restart();
  }
  setConfig(input: unknown): void {
    let config: CardConfigV1;
    try {
      config = validateConfig(input);
    } catch {
      throw new Error(
        "Invalid lightNVR card configuration. Review supported fields and audio/transport settings.",
      );
    }
    if (
      this.configured &&
      JSON.stringify(config) === JSON.stringify(this.configured)
    )
      return;
    const sameMedia =
      this.configured &&
      JSON.stringify({
        ...stripHaMetadata(config),
        controls: { ...config.controls, style: "standard" },
      }) ===
        JSON.stringify({
          ...stripHaMetadata(this.configured),
          controls: { ...this.configured.controls, style: "standard" },
        });
    this.configured = config;
    if (sameMedia && this.config) {
      if (this.config.controls.style !== config.controls.style)
        this.cancelInteractions();
      this.config.controls.style = config.controls.style;
      // Preserve local profile/volume and active gestures; only replace HA-owned metadata.
      this.config = withHaMetadata(this.config, config);
      if (this.fullscreenRestore)
        this.fullscreenRestore = withHaMetadata(
          {
            ...this.fullscreenRestore,
            controls: {
              ...this.fullscreenRestore.controls,
              style: config.controls.style,
            },
          },
          config,
        );
      this.requestUpdate();
      return;
    }
    this.config = structuredClone(config);
    this.fullscreenRestore = undefined;
    this.upgradeFailed = false;
    this.notice = "";
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.restart();
  }
  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("blur", this.cancelInteractions);
    window.addEventListener("pointerup", this.releasePointer);
    window.addEventListener("pointercancel", this.releasePointer);
    window.addEventListener("keyup", this.releaseKey);
    window.addEventListener("keydown", this.escape);
    document.addEventListener("visibilitychange", this.visibilityChanged);
    document.addEventListener("fullscreenchange", this.fullscreenChanged);
    if (typeof IntersectionObserver !== "undefined") {
      this.observer = new IntersectionObserver((entries) => {
        const entry = entries.find((e) => e.target === this);
        if (!entry) return;
        this.offscreen = !entry.isIntersecting;
        this.updateVisibility();
      });
      this.observer.observe(this);
    }
    this.restart();
  }
  disconnectedCallback(): void {
    this.revision++;
    this.cancelInteractions();
    const old = this.session;
    this.session = undefined;
    this.teardown = Promise.all([
      this.teardown,
      old?.dispose() ?? Promise.resolve(),
    ]).then(() => {});
    this.observer?.disconnect();
    this.observer = undefined;
    window.removeEventListener("blur", this.cancelInteractions);
    window.removeEventListener("pointerup", this.releasePointer);
    window.removeEventListener("pointercancel", this.releasePointer);
    window.removeEventListener("keyup", this.releaseKey);
    window.removeEventListener("keydown", this.escape);
    document.removeEventListener("visibilitychange", this.visibilityChanged);
    document.removeEventListener("fullscreenchange", this.fullscreenChanged);
    this.clearDownload();
    super.disconnectedCallback();
  }
  private restart(): void {
    const revision = ++this.revision;
    this.cancelInteractions();
    const old = this.session;
    this.session = undefined;
    this.clearDownload();
    this.requestUpdate();
    const disposed = (this.teardown = Promise.all([
      this.teardown,
      old?.dispose() ?? Promise.resolve(),
    ]).then(() => {}));
    if (!this.isConnected || !this.config) return;
    void (async () => {
      await disposed;
      await this.updateComplete;
      if (!this.isConnected || revision !== this.revision || !this.config)
        return;
      const video = this.renderRoot.querySelector("video");
      if (!video) return;
      video.volume = this.config.audio.volume;
      const session = new ViewerSession(
        this.config,
        video,
        () => {
          this.requestUpdate();
          const upgrade = this.session?.snapshot;
          const blocked =
            this.session?.privateCamera ||
            ["auth", "policy", "privacy", "password-change", "totp"].includes(
              upgrade?.failure?.code ?? "",
            );
          if (
            this.fullscreenRestore &&
            !this.upgradeFailed &&
            upgrade &&
            ["failed", "offline"].includes(upgrade.state) &&
            !blocked
          ) {
            this.upgradeFailed = true;
            this.notice =
              "Main fullscreen upgrade failed; returning to selected profile.";
            this.config = this.fullscreenRestore;
            this.restart();
          }
        },
        this.runtime,
      );
      this.session = session;
      this.updateVisibility();
      void session.start();
    })();
  }
  private visibilityChanged = (): void => {
    if (document.hidden) this.cancelInteractions();
    this.updateVisibility();
  };
  private updateVisibility(): void {
    this.session?.setVisible(
      !document.hidden && !this.offscreen,
      !this.offscreen,
    );
  }
  private cancelInteractions = (): void => {
    this.inputOwner = undefined;
    this.session?.stopInteractions();
  };
  private releasePointer = (event: PointerEvent): void => {
    if (this.inputOwner?.pointer === event.pointerId) {
      const toggle =
        this.inputOwner.kind === "talk" &&
        this.config?.audio.talk_mode === "toggle" &&
        event.type === "pointerup";
      this.inputOwner = undefined;
      if (!toggle) this.session?.stopInteractions();
    }
  };
  private escape = (event: KeyboardEvent): void => {
    if (event.key === "Escape") this.cancelInteractions();
  };
  private releaseKey = (event: KeyboardEvent): void => {
    if (this.inputOwner?.key === event.key) {
      event.preventDefault();
      const toggle =
        this.inputOwner.kind === "talk" &&
        this.config?.audio.talk_mode === "toggle";
      this.inputOwner = undefined;
      if (!toggle) this.session?.stopInteractions();
    }
  };
  private begin(kind: "talk" | "ptz", axes?: PtzAxes): void {
    const session = this.session;
    if (!session) return;
    if (kind === "talk") {
      const access = audioAvailability(
        "audio.talk",
        session.config,
        session.snapshot,
        session.caps,
        session.camera
          ? {
              ...session.camera,
              privacy: session.controlState.privacy ?? session.camera.privacy,
            }
          : undefined,
      );
      if (
        session.privateCamera ||
        !access.enabled ||
        session.denied.has("audio.talk")
      )
        return;
      if (
        this.config?.audio.talk_mode === "toggle" &&
        (session.snapshot.talk.active || session.snapshot.talk.pending)
      )
        session.stopTalk();
      else session.startTalk();
    } else if (axes) session.startPtz(axes, this.speed);
  }
  private pointerStart(
    event: PointerEvent,
    kind: "talk" | "ptz",
    axes?: PtzAxes,
  ): void {
    if (event.button !== 0 || this.inputOwner) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLButtonElement;
    target.focus();
    this.inputOwner = { kind, pointer: event.pointerId };
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      /* Window release listeners cover missing pointer capture. */
    }
    this.begin(kind, axes);
  }
  private keyStart(
    event: KeyboardEvent,
    kind: "talk" | "ptz",
    axes?: PtzAxes,
  ): void {
    if (![" ", "Enter"].includes(event.key)) return;
    event.preventDefault();
    if (event.repeat || this.inputOwner) return;
    this.inputOwner = { kind, key: event.key };
    this.begin(kind, axes);
  }
  private lostCapture = (): void => {
    // Normal toggle release has already cleared its input owner; cancellation still stops talk.
    if (this.inputOwner) this.cancelInteractions();
  };
  private async snapshot(): Promise<void> {
    const session = this.session;
    const blob = await session?.snapshotBlob();
    if (!session || !blob || session !== this.session || !this.isConnected)
      return;
    this.clearDownload();
    this.downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = this.downloadUrl;
    const name = (session.camera?.name ?? "camera")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 64);
    link.download = `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;
    link.click();
    this.downloadTimer = setTimeout(() => this.clearDownload(), 1000);
  }
  private clearDownload(): void {
    clearTimeout(this.downloadTimer);
    if (this.downloadUrl) URL.revokeObjectURL(this.downloadUrl);
    this.downloadUrl = "";
  }
  private async fullscreen(): Promise<void> {
    this.cancelInteractions();
    try {
      if (document.fullscreenElement === this) await document.exitFullscreen();
      else if (this.requestFullscreen) await this.requestFullscreen();
      else {
        this.notice = "Fullscreen is unavailable in this browser.";
        this.requestUpdate();
      }
    } catch {
      this.notice = "Fullscreen request was blocked.";
      this.requestUpdate();
    }
  }
  private fullscreenChanged = (): void => {
    this.cancelInteractions();
    if (
      document.fullscreenElement === this &&
      this.config?.layout.fullscreen_main &&
      this.config.profile === "sub" &&
      !this.config.source &&
      this.session?.camera?.sources.main
    ) {
      this.fullscreenRestore = this.config;
      this.upgradeFailed = false;
      this.config = { ...this.config, profile: "main" };
      this.restart();
    } else if (document.fullscreenElement !== this && this.fullscreenRestore) {
      this.config = this.fullscreenRestore;
      this.fullscreenRestore = undefined;
      this.restart();
    }
  };
  private profile(event: Event): void {
    if (!this.config) return;
    this.cancelInteractions();
    this.fullscreenRestore = undefined;
    this.config = {
      ...this.config,
      profile: (event.target as HTMLSelectElement).value as "main" | "sub",
    };
    this.restart();
  }
  private show(
    name: Exclude<keyof CardConfigV1["controls"], "style">,
  ): boolean {
    return this.config?.controls[name] ?? name !== "refresh_source";
  }
  private access(action: Action) {
    return availability(
      action,
      this.session?.camera
        ? {
            ...this.session.camera,
            privacy:
              this.session.controlState.privacy ?? this.session.camera.privacy,
          }
        : undefined,
      this.session?.denied,
    );
  }
  private button(
    label: string,
    action: Action,
    run: () => void,
    icon?: ToolbarIcon,
  ) {
    const access = this.access(action);
    return html`<button ?disabled=${!access.enabled || this.session?.busy} aria-label=${label} title=${icon ? `${label} · ${access.reason}` : access.reason} @blur=${() => {
      if (action === "ptz") this.cancelInteractions();
    }} @click=${run}>${icon ? toolbarIcon(icon) : label}</button>${icon ? nothing : html`<span class="hint">${access.reason}</span>`}`;
  }
  private hold(
    label: string,
    kind: "talk" | "ptz",
    disabled: boolean,
    reason: string,
    axes?: PtzAxes,
    icon?: ToolbarIcon,
  ) {
    return html`<button class="hold" ?disabled=${disabled} title=${icon ? `${label} · ${reason}` : reason} aria-label=${label} aria-describedby=${kind === "talk" ? `${this.scope}-mic-hint` : nothing}
      aria-pressed=${kind === "talk" ? String(this.session?.snapshot.talk.active ?? false) : nothing}
      @pointerdown=${(event: PointerEvent) => this.pointerStart(event, kind, axes)}
      @pointerup=${this.releasePointer} @pointercancel=${this.cancelInteractions} @lostpointercapture=${this.lostCapture}
      @keydown=${(event: KeyboardEvent) => this.keyStart(event, kind, axes)} @keyup=${this.releaseKey}
      @blur=${this.cancelInteractions} @contextmenu=${(event: Event) => event.preventDefault()}
      @click=${(event: MouseEvent) => {
        // Assistive technology click (no pointer/key sequence) is a deliberate toggle.
        if (event.detail === 0 && !this.inputOwner && kind === "talk") {
          if (this.config?.audio.talk_mode === "toggle") this.begin("talk");
          else {
            this.notice = "Hold Space or Enter to talk; release to stop.";
            this.requestUpdate();
          }
        }
      }}>${icon ? toolbarIcon(icon) : label}</button>`;
  }
  protected updated(): void {
    const video = this.renderRoot.querySelector("video");
    if (video && this.session) video.volume = this.config?.audio.volume ?? 1;
  }
  private async openDiagnostics(): Promise<void> {
    this.cancelInteractions();
    this.advancedOpen = true;
    this.requestUpdate();
    await this.updateComplete;
    const details =
      this.renderRoot.querySelector<HTMLDetailsElement>(".diagnostics");
    if (details) {
      details.open = true;
      details.scrollIntoView?.({ block: "nearest" });
    }
  }
  protected render() {
    const config = this.config;
    if (!config) return nothing;
    const session = this.session;
    const snapshot = session?.snapshot;
    const speaker = audioAvailability(
      "audio.listen",
      config,
      snapshot ?? {
        state: "idle",
        attempt: 0,
        talking: false,
        talk: { active: false, pending: false },
      },
      session?.caps,
      session?.camera
        ? {
            ...session.camera,
            privacy: session.controlState.privacy ?? session.camera.privacy,
          }
        : undefined,
    );
    const mic = audioAvailability(
      "audio.talk",
      config,
      snapshot ?? {
        state: "idle",
        attempt: 0,
        talking: false,
        talk: { active: false, pending: false },
      },
      session?.caps,
      session?.camera
        ? {
            ...session.camera,
            privacy: session.controlState.privacy ?? session.camera.privacy,
          }
        : undefined,
    );
    const link = timelineLink(
      config,
      session?.camera,
      new Date(),
      document.fullscreenElement === this,
    );
    const ptz = this.access("ptz");
    const video = this.renderRoot?.querySelector("video");
    const width = video?.videoWidth || 16,
      height = video?.videoHeight || 9;
    const overlay = config.controls.style === "overlay";
    const toolbar = html`<div class=${overlay ? "toolbar overlay-toolbar" : "row toolbar"} role="group" aria-label="Camera controls">
      ${overlay ? html`<span class=${snapshot?.talk.active ? "toolbar-state talking" : snapshot?.talk.pending ? "toolbar-state pending" : "toolbar-state"} role="status">${snapshot?.talk.active ? "MIC LIVE" : snapshot?.talk.pending ? "MIC…" : (this.show("transport") ? (snapshot?.transport ?? snapshot?.state ?? "Connecting") : (snapshot?.state ?? "Connecting")).toUpperCase()}</span>` : nothing}
      <button aria-label="Play / retry locally" title="Play / retry locally" ?disabled=${session?.authBusy} @click=${() => {
        this.cancelInteractions();
        void session?.retry();
      }}>${overlay ? toolbarIcon("retry") : "Play / retry locally"}</button>
      ${overlay && this.show("snapshot") ? this.button("Snapshot", "snapshot", () => void this.snapshot(), "snapshot") : nothing}
      ${this.show("speaker") ? html`<button aria-label=${session?.listening ? "Mute speaker" : "Listen"} aria-pressed=${String(session?.listening ?? false)} ?disabled=${!speaker.enabled || session?.denied.has("audio.listen")} title=${`${session?.listening ? "Mute speaker" : "Listen"} · ${speaker.reason}`} @click=${() => void session?.speaker()}>${overlay ? toolbarIcon(session?.listening ? "speaker" : "muted") : session?.listening ? "Mute speaker" : "Listen"}</button>` : nothing}
      ${this.show("microphone") ? this.hold(config.audio.talk_mode === "ptt" ? "Hold to talk" : "Toggle microphone", "talk", !mic.enabled || (session?.denied.has("audio.talk") ?? false), mic.reason, undefined, overlay ? "microphone" : undefined) : nothing}
      ${this.show("fullscreen") ? html`<button aria-label="Fullscreen" title="Fullscreen" @click=${() => void this.fullscreen()}>${overlay ? toolbarIcon("fullscreen") : "Fullscreen"}</button>` : nothing}
      ${!overlay && this.show("snapshot") ? this.button("Snapshot", "snapshot", () => void this.snapshot()) : nothing}
      ${
        overlay
          ? html`<button aria-label="Camera settings" title="Camera settings" aria-expanded=${String(this.advancedOpen)} aria-controls=${`${this.scope}-advanced`} @click=${() => {
              this.cancelInteractions();
              this.advancedOpen = !this.advancedOpen;
              this.requestUpdate();
            }}>${toolbarIcon("settings")}</button>`
          : nothing
      }
    </div>`;
    return html`<ha-card class=${overlay ? "appearance-overlay" : "appearance-standard"}>
      <header>${config.title ?? config.stream}</header>
      <div class="viewport" style=${`aspect-ratio:${config.layout.aspect_ratio}`}>
        <div class="image" style=${`transform:translate(${this.panX}%,${this.panY}%) scale(${this.zoom})`}>
          <video autoplay playsinline muted style=${`object-fit:${config.layout.object_fit};visibility:${session?.privateCamera ? "hidden" : "visible"}`} @loadedmetadata=${() => this.requestUpdate()}></video>
          ${session?.detectionEnabled && !session.privateCamera ? html`<svg width="100%" height="100%" viewBox=${`0 0 ${width} ${height}`} preserveAspectRatio=${config.layout.object_fit === "cover" ? "xMidYMid slice" : "xMidYMid meet"} aria-label="Detection overlay">${session.detections.map((d) => html`<g><rect x=${d.x * width} y=${d.y * height} width=${d.width * width} height=${d.height * height}></rect><text x=${d.x * width} y=${Math.max(14, d.y * height)}>${d.label}</text></g>`)}</svg>` : nothing}
        </div>
        ${overlay ? toolbar : nothing}
      </div>
      <div class="body">
        <div class=${overlay && snapshot?.state === "playing" && !snapshot.failure ? "status sr-only" : "status"} role="status">${snapshot?.state === "idle" && session?.authBusy ? "connecting" : snapshot?.state === "idle" && session?.auth ? "sign-in required" : snapshot?.state === "idle" && session?.message ? "connection failed" : (snapshot?.state ?? "Connecting")}${this.show("transport") && snapshot?.transport ? ` · ${snapshot.transport.toUpperCase()}` : ""}${snapshot?.failure ? ` · ${snapshot.failure.message}` : ""}</div>
        ${this.show("transport") && snapshot?.state === "playing" && session?.fallbackReason ? html`<div class="hint">Previous playback issue: ${session.fallbackReason}</div>` : nothing}
        ${session?.message || this.notice ? html`<p class="message" role="status">${session?.message} ${this.notice}</p>` : nothing}
        ${session?.message || snapshot?.failure || session?.fallbackReason ? html`<button @click=${() => void this.openDiagnostics()}>Show connection diagnostics</button>` : nothing}
        ${snapshot?.talk.failure ? html`<p role="alert">Microphone: ${snapshot.talk.failure.message}</p>` : nothing}
        ${session?.auth ? this.authForm(session) : nothing}
        ${overlay ? nothing : toolbar}
        <div class="advanced" id=${`${this.scope}-advanced`} ?hidden=${overlay && !this.advancedOpen}>
        ${this.show("microphone") ? html`<div class="hint" id=${`${this.scope}-mic-hint`}>${mic.reason}</div><div role="status" class=${snapshot?.talk.active ? "mic" : "hint"}>${snapshot?.talk.active ? "Microphone active" : snapshot?.talk.pending ? "Waiting for microphone permission…" : "Microphone off"} ${snapshot?.talk.level !== undefined ? html`<meter min="0" max="1" .value=${snapshot.talk.level} aria-label="Local microphone level"></meter>` : nothing}</div>` : nothing}
        ${
          this.show("speaker")
            ? html`<label>Speaker volume <input aria-label="Speaker volume" type="range" min="0" max="1" step="0.05" .value=${String(config.audio.volume)} @input=${(
                event: Event,
              ) => {
                if (this.config)
                  this.config.audio.volume = Number(
                    (event.target as HTMLInputElement).value,
                  );
                this.requestUpdate();
              }}></label>`
            : nothing
        }
        ${this.show("profile") ? html`<label>Source profile <select aria-label="Source profile" .value=${config.profile} ?disabled=${!session?.camera || !!config.source} @change=${this.profile}><option value="main">Main</option><option value="sub" ?disabled=${!session?.camera?.sources.sub}>Sub</option></select></label>` : nothing}
        ${
          this.show("zoom")
            ? html`<details><summary>Digital zoom / pan (local)</summary><label>Zoom <input type="range" min="1" max="5" step="0.1" .value=${String(this.zoom)} @input=${(
                event: Event,
              ) => {
                this.zoom = Number((event.target as HTMLInputElement).value);
                this.requestUpdate();
              }}></label>${(["X", "Y"] as const).map(
                (axis) =>
                  html`<label>Pan ${axis}<input type="range" min="-40" max="40" .value=${String(axis === "X" ? this.panX : this.panY)} @input=${(
                    event: Event,
                  ) => {
                    const value = Number(
                      (event.target as HTMLInputElement).value,
                    );
                    if (axis === "X") this.panX = value;
                    else this.panY = value;
                    this.requestUpdate();
                  }}></label>`,
              )}<button @click=${() => {
                this.zoom = 1;
                this.panX = 0;
                this.panY = 0;
                this.requestUpdate();
              }}>Reset view</button><p class="hint">Motorized PTZ is separate. Fisheye/ePTZ is unavailable in this viewer contract.</p></details>`
            : nothing
        }
        ${
          this.show("ptz")
            ? html`<details @toggle=${(event: Event) => {
                if ((event.target as HTMLDetailsElement).open)
                  void session?.read("ptz");
                else this.cancelInteractions();
              }}><summary>Motorized PTZ</summary><p class="hint">${ptz.reason}</p>
          <label>Speed <input type="range" min="0.05" max="1" step="0.05" .value=${String(this.speed)} @input=${(
            event: Event,
          ) => {
            this.speed = Number((event.target as HTMLInputElement).value);
          }}></label>
          <div class="ptz">${[
            ["Up left", { x: -1, y: 1 }],
            ["Up", { y: 1 }],
            ["Up right", { x: 1, y: 1 }],
            ["Left", { x: -1 }],
            ["Down", { y: -1 }],
            ["Right", { x: 1 }],
            ["Zoom in", { z: 1 }],
            ["Zoom out", { z: -1 }],
          ].map(([label, axes]) =>
            this.hold(
              label as string,
              "ptz",
              !ptz.enabled ||
                session?.busy === true ||
                (axes && "z" in (axes as PtzAxes)
                  ? session?.controlState.ptz?.zoom === false
                  : session?.controlState.ptz?.pan === false),
              ptz.reason,
              axes as PtzAxes,
            ),
          )}</div>
          <button ?disabled=${!ptz.enabled} @click=${() => {
            this.cancelInteractions();
            session?.emergencyStop();
          }}>Stop PTZ / talk</button>
          ${this.button("Home", "ptz", () => void session?.mutate({ action: "ptz", command: "home" }))}
          <label>Preset <select aria-label="PTZ preset" .value=${this.preset} @change=${(
            event: Event,
          ) => {
            this.preset = (event.target as HTMLSelectElement).value;
          }}><option value="">Select preset</option>${session?.controlState.presets?.map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select></label>
          ${this.button("Go to preset", "ptz", () => {
            if (this.preset)
              void session?.mutate({
                action: "ptz",
                command: "goto-preset",
                preset: this.preset,
              });
          })}
          <label>New preset name <input maxlength="63" .value=${this.presetName} @input=${(
            event: Event,
          ) => {
            this.presetName = (event.target as HTMLInputElement).value;
          }}></label>
          ${this.button("Save preset", "ptz", () => {
            if (this.presetName.trim())
              void session?.mutate({
                action: "ptz",
                command: "save-preset",
                preset: this.presetName.trim(),
              });
          })}
          ${this.button("Set home", "ptz", () => void session?.mutate({ action: "ptz", command: "set-home" }))}
        </details>`
            : nothing
        }
        <div class="row">
          ${
            this.show("daynight")
              ? html`<label>Day/night <select aria-label="Day/night" ?disabled=${!this.access("daynight").enabled || session?.busy} title=${this.access("daynight").reason} @change=${(
                  event: Event,
                ) => {
                  const target = event.target as HTMLSelectElement;
                  const mode = target.value as "auto" | "day" | "night";
                  target.value = "";
                  if (mode) void session?.mutate({ action: "daynight", mode });
                }}><option value="">Set mode…</option><option value="auto">Auto</option><option value="day">Day</option><option value="night">Night</option></select></label>`
              : nothing
          }
          ${this.show("recording") ? this.button(`Toggle recording (${session?.controlState.recording === undefined ? "read on click" : session.controlState.recording ? "running" : "stopped"})`, "recording", () => void session?.mutate({ action: "recording", enabled: true })) : nothing}
          ${this.show("privacy") ? this.button("Toggle camera privacy", "privacy", () => void session?.mutate({ action: "privacy", enabled: true })) : nothing}
          ${this.show("detection") ? this.button(session?.detectionEnabled ? "Hide detections" : "Show detections", "detection", () => session?.toggleDetections()) : nothing}
          ${this.show("refresh_source") ? this.button("Refresh source (all viewers)", "refresh", () => void session?.mutate({ action: "refresh" })) : nothing}
        <details class="diagnostics"><summary>Connection diagnostics</summary><p class="hint">Contains fixed operation/error labels and timestamps. No passwords, server URLs, camera URLs or SDP.</p><pre>${JSON.stringify(session?.diagnostics() ?? {}, null, 2)}</pre><button @click=${async () => {
          try {
            await navigator.clipboard.writeText(
              JSON.stringify(session?.diagnostics() ?? {}, null, 2),
            );
            this.notice = "Diagnostics copied.";
          } catch {
            this.notice = "Copy unavailable. Select the diagnostic text above.";
          }
          this.requestUpdate();
        }}>Copy diagnostics</button></details>
        </div>
        ${
          this.show("timeline")
            ? link
              ? html`<a href=${link} target="_blank" rel="noopener noreferrer" @click=${(
                  event: MouseEvent,
                ) => {
                  if (!this.config) return;
                  const current = timelineLink(
                    this.config,
                    this.session?.camera,
                    new Date(),
                    document.fullscreenElement === this,
                  );
                  if (current)
                    (event.currentTarget as HTMLAnchorElement).href = current;
                }}>${session?.camera ? "Open camera timeline in lightNVR" : "Open lightNVR"}</a>`
              : html`<p class="hint">Set viewer_url to the confirmed lightNVR web UI URL to open its timeline.</p>`
            : nothing
        }
        </div>
      </div>
    </ha-card>`;
  }
  private authForm(session: ViewerSession) {
    if (session.auth === "password-change")
      return html`<p role="alert">Change the password in lightNVR, then retry locally.</p>`;
    return html`<form @submit=${(event: SubmitEvent) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const values = new FormData(form);
      const username = String(values.get("username") ?? ""),
        password = String(values.get("password") ?? ""),
        otp = String(values.get("otp") ?? "");
      if (session.authBusy) return;
      form.reset();
      void session.start(
        session.auth === "totp" ? undefined : { username, password },
        otp || undefined,
      );
    }}>${session.auth === "totp" ? html`<label for=${`${this.scope}-otp`}>One-time code</label><input id=${`${this.scope}-otp`} name="otp" inputmode="numeric" autocomplete="one-time-code" required>` : html`<label for=${`${this.scope}-user`}>Username</label><input id=${`${this.scope}-user`} name="username" autocomplete="username" required><label for=${`${this.scope}-pass`}>Password</label><input id=${`${this.scope}-pass`} name="password" type="password" autocomplete="current-password" required>`}<button type="submit" ?disabled=${session.authBusy}>Authenticate for this session</button></form>`;
  }
}
