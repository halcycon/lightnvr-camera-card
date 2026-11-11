import {
  stripHaMetadata,
  NvrError,
  type CameraSummary,
  type CardConfigV1,
  type ClientConfig,
  type PlaybackController,
  type PlaybackDependencies,
  type PlaybackFailure,
  type PlaybackSnapshot,
  type PlaybackState,
  type SourceSelection,
  type TalkState,
  type Transport,
  type TransportAdapter,
  type TransportEvent,
} from "../contracts";
import { selectSource } from "../api/mapping";
import { failure, safeDiagnostic } from "../api/safety";
import { acquireStartup } from "./startup";
import { transportAvailable } from "./policy";

const CLEANUP_MS = 1000;
const safeCall = (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    return Promise.resolve(fn()).catch(() => {});
  } catch {
    return Promise.resolve();
  }
};
function bounded(work: Promise<unknown>, ms = CLEANUP_MS): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener("abort", cancel);
      reject(failure("cancelled"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
    if (signal.aborted) cancel();
  });
}
interface Attempt {
  generation: number;
  abort: AbortController;
  adapter?: TransportAdapter;
  release?: () => void;
  deadline?: ReturnType<typeof setTimeout>;
  failed: boolean;
  rendered: boolean;
  autoplay: boolean;
  playRevision: number;
}
type SnapshotPatch = {
  [K in keyof PlaybackSnapshot]?: PlaybackSnapshot[K] | undefined;
};

/** One controller per card/video. The caller owns the injected API client's lifetime. */
export function createPlaybackController({
  client,
  createTransport,
  talk,
}: PlaybackDependencies): PlaybackController {
  let snapshot: PlaybackSnapshot = Object.freeze({
    state: "idle",
    attempt: 0,
    talking: false,
    talk: Object.freeze({ active: false, pending: false }),
  });
  const listeners = new Set<(value: PlaybackSnapshot) => void>();
  let config: CardConfigV1 | undefined,
    video: HTMLVideoElement | undefined,
    configKey = "";
  let generation = 0,
    current: Attempt | undefined,
    disposed = false,
    running = false,
    visible = true;
  let speaker = false,
    retries = 0,
    index = 0;
  let capabilities: ClientConfig | undefined,
    camera: CameraSummary | undefined,
    source: SourceSelection | undefined;
  let order: Transport[] = [];
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let detachSignal: (() => void) | undefined;
  let cleanup: Promise<void> = Promise.resolve();
  let disposal: Promise<void> | undefined;
  const document = globalThis.document;
  const suspended = () =>
    !!config &&
    ((!visible && config.playback_visibility.offscreen === "pause") ||
      (document?.hidden && config.playback_visibility.hidden === "pause"));
  const publish = (patch: SnapshotPatch) => {
    const next = { ...snapshot, ...patch };
    if (next.failure === undefined) delete next.failure;
    else next.failure = Object.freeze({ ...next.failure });
    if (next.transport === undefined) delete next.transport;
    snapshot = Object.freeze(next) as PlaybackSnapshot;
    // oxlint-disable-next-line unicorn/no-useless-spread -- Callbacks may mutate subscriptions; notify a fixed snapshot.
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        /* Observers cannot interrupt lifecycle cleanup. */
      }
    }
  };
  const talkSnapshot = (state: Readonly<TalkState>) => {
    const copy = Object.freeze({
      ...state,
      ...(state.failure
        ? { failure: Object.freeze({ ...state.failure }) }
        : {}),
    });
    publish({ talk: copy, talking: copy.active });
  };
  const unsubscribeTalk = talk.subscribe(talkSnapshot);
  const live = (a: Attempt) =>
    !disposed &&
    running &&
    current === a &&
    a.generation === generation &&
    !a.abort.signal.aborted;
  const clearDeadline = (a: Attempt) => {
    clearTimeout(a.deadline);
    delete a.deadline;
  };
  const release = (a: Attempt) => {
    a.release?.();
    delete a.release;
  };
  function retire(): Promise<void> {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    // stop() kills capture synchronously. Close the peer before waiting for serialized detach.
    const stoppedTalk = safeCall(() => talk.stop());
    const a = current;
    current = undefined;
    if (a) {
      clearDeadline(a);
      a.abort.abort();
      release(a);
    }
    const stoppedAdapter = a?.adapter
      ? safeCall(() => a.adapter!.stop())
      : Promise.resolve();
    cleanup = bounded(Promise.all([cleanup, stoppedTalk, stoppedAdapter]));
    return cleanup;
  }
  const timeout = (kind?: Transport) => {
    if (!config) return 30000;
    return (
      (kind ? config.timeouts[`${kind}_ms`] : undefined) ??
      (config.timeouts.connection_ms === "inherit"
        ? (capabilities?.connectionTimeoutMs ?? 30000)
        : config.timeouts.connection_ms)
    );
  };
  const deadline = (a: Attempt, ms: number) => {
    clearDeadline(a);
    a.deadline = setTimeout(() => {
      void fail(a, failure("timeout").failure);
    }, ms);
  };
  function terminal(f: PlaybackFailure): PlaybackState | undefined {
    if (
      f.status === 401 ||
      ["auth", "password-change", "totp"].includes(f.code)
    )
      return "auth-required";
    if (f.status === 403 || ["policy", "privacy"].includes(f.code))
      return "denied";
    if (f.code === "configuration") return "failed";
    if (f.code === "cancelled") return "stopped";
    return undefined;
  }
  async function fail(a: Attempt, input: PlaybackFailure): Promise<void> {
    if (!live(a) || a.failed) return;
    const f = safeDiagnostic(new NvrError(input));
    if (f.code === "autoplay" && !terminal(f)) {
      a.autoplay = true;
      a.playRevision++;
      clearDeadline(a);
      release(a);
      void safeCall(() => talk.stop());
      publish({ state: "suspended", failure: f });
      return;
    }
    a.failed = true;
    const end = terminal(f);
    const next =
      !end &&
      f.code !== "source-offline" &&
      f.code !== "rate-limit" &&
      index + 1 < order.length;
    const g = generation;
    const stopped = retire();
    publish({
      state: end ?? (f.code === "source-offline" ? "offline" : "recovering"),
      failure: f,
    });
    await stopped;
    if (g !== generation || !running || disposed) return;
    if (end || f.code === "cancelled") return;
    if (next) {
      index++;
      void launch(g);
      return;
    }
    if (!config || retries >= config.retry.attempts) {
      publish({ state: f.code === "source-offline" ? "offline" : "failed" });
      return;
    }
    const { base_ms, cap_ms, jitter } = config.retry;
    const exponential = Math.min(cap_ms, base_ms * 2 ** retries++);
    const delay = Math.max(
      100,
      Math.min(
        300000,
        Math.max(
          f.retryAfterMs ?? 0,
          Math.min(
            cap_ms,
            exponential * (1 + jitter * (2 * Math.random() - 1)),
          ),
        ),
      ),
    );
    if (f.code !== "source-offline" && f.code !== "rate-limit") index = 0;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void launch(g);
    }, delay);
  }
  function event(a: Attempt, e: TransportEvent): void {
    if (!live(a) || a.failed) return;
    if (e.type === "failure") {
      void fail(a, e.failure);
      return;
    }
    if (e.type === "first-frame" && e.transport === a.adapter?.kind) {
      // A retained autoplay-blocked player may decode while paused; still require the gesture.
      a.rendered = true;
      if (
        snapshot.failure?.code === "autoplay" &&
        snapshot.state === "suspended"
      )
        return;
      clearDeadline(a);
      release(a);
      retries = 0;
      a.autoplay = false;
      publish({ state: "playing", failure: undefined });
    } else if (
      e.type === "state" &&
      e.state === "recovering" &&
      snapshot.state === "playing"
    ) {
      void safeCall(() => talk.stop());
      publish({ state: "recovering" });
      deadline(a, timeout(a.adapter?.kind));
    } else if (
      e.type === "state" &&
      e.state === "playing" &&
      a.rendered &&
      !a.autoplay
    ) {
      clearDeadline(a);
      publish({ state: "playing", failure: undefined });
    }
  }
  async function launch(g: number): Promise<void> {
    if (g !== generation || !config || !video || !running || disposed) return;
    if (suspended()) {
      publish({ state: "suspended" });
      return;
    }
    const a: Attempt = {
      generation: g,
      abort: new AbortController(),
      failed: false,
      rendered: false,
      autoplay: false,
      playRevision: 0,
    };
    current = a;
    publish({ state: "queued", attempt: snapshot.attempt + 1 });
    try {
      a.release = await acquireStartup(
        client.profile.sessionScope,
        a.abort.signal,
      );
      if (!live(a)) {
        release(a);
        return;
      }
      publish({ state: "connecting" });
      deadline(a, timeout(order[index]));
      const signal = a.abort.signal;
      const login = await abortable(
        client.connect(undefined, { signal }),
        signal,
      );
      if (!live(a)) return;
      if (login.kind === "totp-required") throw failure("totp");
      if (login.kind === "password-change-required" || login.mustChangePassword)
        throw failure("password-change");
      const [inventory, settings] = await abortable(
        Promise.all([
          client.discover({ signal }),
          client.clientConfig({ signal }),
        ]),
        signal,
      );
      if (!live(a)) return;
      capabilities = settings;
      source = selectSource(config, inventory);
      camera = inventory.find((c) => c.name === source?.camera);
      if (camera?.privacy === true) throw failure("privacy");
      if (camera?.capabilities["live.view"] === "denied")
        throw failure("policy");
      if (camera?.status === "offline" || camera?.status === "disabled")
        throw failure("source-offline");
      // Filtering never invents a transport outside the configured order (including fixed mode).
      order = config.transports.filter((kind) =>
        transportAvailable(kind, settings, client, video!),
      );
      const kind = order[index];
      if (!kind) throw failure("unsupported-api");
      a.adapter = createTransport(kind);
      publish({ transport: kind });
      deadline(a, timeout(kind));
      const attemptConfig: CardConfigV1 = {
        ...config,
        audio: { ...config.audio, muted: !speaker },
      };
      await abortable(
        a.adapter.start({
          video,
          config: attemptConfig,
          source,
          ...(camera ? { camera } : {}),
          capabilities: settings,
          client,
          signal,
          emit: (e) => event(a, e),
        }),
        signal,
      );
    } catch (error) {
      if (live(a)) await fail(a, safeDiagnostic(error));
    }
  }
  function restart(resetSpeaker: boolean): Promise<void> {
    const g = ++generation;
    const stopped = retire();
    retries = 0;
    index = 0;
    order = [];
    capabilities = undefined;
    camera = undefined;
    source = undefined;
    if (resetSpeaker)
      speaker =
        !!config?.audio.enabled && !!config.audio.listen && !config.audio.muted;
    publish({ transport: undefined, failure: undefined, attempt: 0 });
    return stopped.then(() => launch(g));
  }
  async function resume(): Promise<void> {
    const a = current;
    if (!a || !live(a) || !video) return;
    const revision = ++a.playRevision;
    publish({ state: "connecting", failure: undefined });
    deadline(a, timeout(a.adapter?.kind));
    try {
      // Called before any await: retain the explicit gesture, without microphone acquisition.
      await abortable(video.play(), a.abort.signal);
      if (
        live(a) &&
        a.playRevision === revision &&
        a.rendered &&
        !video.paused
      ) {
        a.autoplay = false;
        clearDeadline(a);
        release(a);
        publish({ state: "playing", failure: undefined });
      }
    } catch (error) {
      if (live(a) && a.playRevision === revision)
        await fail(
          a,
          failure(
            error instanceof Error && error.name === "NotAllowedError"
              ? "autoplay"
              : "network",
          ).failure,
        );
    }
  }
  const stop = async () => {
    running = false;
    generation++;
    detachSignal?.();
    detachSignal = undefined;
    const stopped = retire();
    publish({ state: "stopped", transport: undefined, failure: undefined });
    await stopped;
  };
  async function updateVisibility(): Promise<void> {
    if (disposed || !running) return;
    if (suspended()) {
      generation++;
      const stopped = retire();
      publish({ state: "suspended", failure: undefined });
      await stopped;
    } else if (snapshot.state === "suspended" && !current) await restart(false);
  }
  const visibilityChanged = () => {
    if (document?.hidden) void safeCall(() => talk.stop());
    void updateVisibility();
  };
  document?.addEventListener("visibilitychange", visibilityChanged);
  return {
    get snapshot() {
      return snapshot;
    },
    start(element, value, signal) {
      if (disposed) return Promise.resolve();
      const key = JSON.stringify(stripHaMetadata(value));
      if (running && element === video && key === configKey && !signal?.aborted)
        return Promise.resolve();
      detachSignal?.();
      detachSignal = undefined;
      video = element;
      config = stripHaMetadata(value);
      configKey = key;
      running = true;
      if (signal) {
        const abort = () => {
          void stop();
        };
        signal.addEventListener("abort", abort, { once: true });
        detachSignal = () => signal.removeEventListener("abort", abort);
        if (signal.aborted) return stop();
      }
      return restart(true);
    },
    retry() {
      if (disposed || !config || !video) return Promise.resolve();
      if (current?.autoplay) return resume();
      running = true;
      return restart(false);
    },
    async setListening(enabled) {
      if (!config || disposed) return;
      if (
        enabled &&
        (!config.audio.enabled ||
          !config.audio.listen ||
          capabilities?.audioDisabled === true ||
          camera?.capabilities["audio.listen"] === "denied")
      )
        throw failure("policy");
      speaker = enabled;
      const a = current;
      if (!a?.adapter || !live(a)) return;
      const blocked =
        snapshot.state === "suspended" && snapshot.failure?.code === "autoplay";
      if (blocked && enabled) {
        publish({ state: "connecting", failure: undefined });
        deadline(a, timeout(a.adapter.kind));
      }
      try {
        await abortable(a.adapter.setListening(enabled), a.abort.signal);
        if (
          live(a) &&
          blocked &&
          enabled &&
          a.rendered &&
          video &&
          !video.paused
        ) {
          a.autoplay = false;
          clearDeadline(a);
          publish({ state: "playing", failure: undefined });
        }
      } catch (error) {
        if (live(a)) {
          const f = safeDiagnostic(error);
          if (f.code === "autoplay") await fail(a, f);
          else throw new NvrError(f);
        }
      }
    },
    async startTalk(signal) {
      const a = current;
      const sender = a?.adapter?.getAudioSender?.();
      if (
        !a ||
        !live(a) ||
        !visible ||
        document?.hidden ||
        snapshot.state !== "playing" ||
        !sender ||
        !config?.audio.enabled ||
        !config.audio.microphone ||
        capabilities?.audioDisabled === true ||
        camera?.capabilities["audio.talk"] === "denied" ||
        camera?.backchannel === "denied"
      )
        throw failure("policy");
      // TalkController retains the gesture signal after attach. retire() invalidates its
      // own request synchronously, including a late permission result on old generations.
      await abortable(talk.start(sender, signal), a.abort.signal);
    },
    stopTalk: () => bounded(safeCall(() => talk.stop())),
    async setVisible(value) {
      if (visible === value || disposed) return;
      visible = value;
      if (!value) void safeCall(() => talk.stop());
      await updateVisibility();
    },
    subscribe(listener) {
      listeners.add(listener);
      try {
        listener(snapshot);
      } catch {
        /* Consistent observer isolation. */
      }
      return () => {
        listeners.delete(listener);
      };
    },
    stop,
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      document?.removeEventListener("visibilitychange", visibilityChanged);
      disposal = (async () => {
        await stop();
        unsubscribeTalk();
        await bounded(safeCall(() => talk.dispose()));
        listeners.clear();
        video = undefined;
        config = undefined;
      })();
      // Do not dispose client: it may be shared, and the card owns its API reference.
      return disposal;
    },
  };
}
