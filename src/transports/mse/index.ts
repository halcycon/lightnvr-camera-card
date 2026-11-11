import type { TransportAdapter, TransportStart } from "../../contracts";
import { failure } from "../../api/safety";
import { canListen, checkPolicy, MediaLifetime } from "./lifecycle";

// Protocol values from the pinned go2rtc MSE negotiation; implementation is independent.
const VIDEO = ["avc1.640029", "avc1.64002A", "avc1.640033", "hvc1.1.6.L153.B0"];
const AUDIO = ["mp4a.40.2", "mp4a.40.5", "flac", "opus"];
type MediaSourceConstructor = {
  new (): MediaSource;
  isTypeSupported(type: string): boolean;
};
export interface MseAdapterOptions {
  mediaSource?: MediaSourceConstructor;
  managedMediaSource?: MediaSourceConstructor;
  createWebSocket?: (url: string) => WebSocket;
  createObjectURL?: (source: MediaSource) => string;
  revokeObjectURL?: (url: string) => void;
}
export function createMseAdapter(
  options: MseAdapterOptions = {},
): TransportAdapter {
  let lifetime: MediaLifetime | undefined;
  return {
    kind: "mse",
    async start(context) {
      lifetime?.close();
      lifetime = undefined;
      checkPolicy(context, "mse");
      if (context.capabilities.go2rtc === "denied") throw failure("policy");
      if (
        context.client.profile.auth !== "session" ||
        !context.client.profile.sameOrigin
      )
        throw failure("configuration");
      const managed =
        options.managedMediaSource ??
        (
          globalThis as typeof globalThis & {
            ManagedMediaSource?: MediaSourceConstructor;
          }
        ).ManagedMediaSource;
      const Source = managed ?? options.mediaSource ?? globalThis.MediaSource;
      if (
        !Source ||
        typeof Source.isTypeSupported !== "function" ||
        (!options.createWebSocket && !globalThis.WebSocket)
      )
        throw failure("unsupported-api");
      const listen = canListen(context);
      const codecs = [...VIDEO, ...(listen ? AUDIO : [])].filter((c) =>
        Source.isTypeSupported(`video/mp4; codecs="${c}"`),
      );
      if (!codecs.some((c) => VIDEO.includes(c)))
        throw failure("unsupported-codec");
      const url = new URL(context.client.mediaUrls(context.source, listen).mse);
      const base = new URL(context.client.profile.go2rtcUrl);
      if (
        url.origin !== base.origin.replace(/^http/, "ws") ||
        url.pathname !== `${base.pathname}api/ws` ||
        url.username ||
        url.password
      )
        throw failure("configuration");
      const scope = (lifetime = new MediaLifetime(context, "mse"));
      if (!scope.alive) return;
      try {
        const ms = new Source();
        const ws = options.createWebSocket
          ? options.createWebSocket(url.href)
          : new WebSocket(url.href);
        ws.binaryType = "arraybuffer";
        scope.own(() => ws.close());
        let sb: SourceBuffer | undefined;
        let queue: ArrayBuffer[] = [],
          bytes = 0,
          inFlight = 0,
          sent = false,
          quotaRetries = 0;
        scope.own(() => {
          queue = [];
          bytes = 0;
          inFlight = 0;
        });
        scope.own(() => {
          if (sb && ms.readyState === "open") {
            try {
              if (sb.updating) sb.abort();
            } finally {
              ms.removeSourceBuffer(sb);
            }
          }
        });
        const send = () => {
          if (
            scope.alive &&
            !sent &&
            ws.readyState === 1 &&
            ms.readyState === "open"
          ) {
            sent = true;
            try {
              ws.send(JSON.stringify({ type: "mse", value: codecs.join(",") }));
            } catch {
              scope.fail("policy");
            }
          }
        };
        const trim = (quota = false): boolean => {
          if (!sb || sb.updating || !sb.buffered.length) return false;
          const start = sb.buffered.start(0),
            end = sb.buffered.end(sb.buffered.length - 1);
          const cutoff = end - (quota ? 2 : 10);
          if (context.video.currentTime < end - 10)
            context.video.currentTime = Math.max(start, end - 1);
          if (cutoff <= start) return false;
          sb.remove(start, cutoff);
          return true;
        };
        const pump = () => {
          if (!scope.alive || !sb || sb.updating) return;
          try {
            if (trim()) return;
            const data = queue[0];
            if (!data) return;
            sb.appendBuffer(data);
            queue.shift();
            bytes -= data.byteLength;
            inFlight = data.byteLength;
            quotaRetries = 0;
          } catch (error) {
            if (
              error instanceof Error &&
              error.name === "QuotaExceededError" &&
              quotaRetries++ === 0
            ) {
              try {
                if (trim(true)) return;
              } catch {
                /* Fail below when eviction is unavailable. */
              }
            }
            scope.fail("buffer");
          }
        };
        scope.on(ms, "sourceopen", send);
        scope.on(ms, "sourceclose", () => scope.fail("network"));
        scope.on(ws, "open", send);
        // Browsers hide upgrade HTTP status. Treat unexplained closure as terminal policy:
        // it could be origin/auth/lease denial, and must never cause a fallback bypass.
        scope.on(ws, "close", () => scope.fail("policy"));
        scope.on(ws, "error", () => scope.fail("policy"));
        scope.on(ws, "message", (event) => {
          if (!scope.alive) return;
          const data: unknown = (event as MessageEvent<unknown>).data;
          if (typeof data === "string") {
            if (data.length > 4096) {
              scope.fail("unsupported-api");
              return;
            }
            try {
              const msg = JSON.parse(data) as {
                type?: unknown;
                value?: unknown;
              };
              if (msg.type === "error") {
                scope.fail("policy");
                return;
              }
              if (
                msg.type !== "mse" ||
                !sent ||
                sb ||
                typeof msg.value !== "string"
              )
                throw failure("unsupported-api");
              const match =
                /^video\/mp4;\s*codecs="([A-Za-z0-9.,\s-]+)"$/i.exec(msg.value);
              const selected = match?.[1]?.split(",").map((c) => c.trim());
              const family = (codec: string) =>
                codec.split(".")[0]?.toLowerCase();
              // Negotiation advertises decode limits; the source may return a lower profile.
              if (
                !selected?.length ||
                !selected.some((c) =>
                  ["avc1", "hvc1"].includes(family(c) ?? ""),
                ) ||
                selected.some(
                  (c) =>
                    !codecs.some((offered) => family(offered) === family(c)),
                ) ||
                !Source.isTypeSupported(msg.value)
              )
                throw failure("unsupported-codec");
              sb = ms.addSourceBuffer(msg.value);
              sb.mode = "segments";
              scope.on(sb, "updateend", () => {
                inFlight = 0;
                pump();
              });
              scope.on(sb, "error", () => scope.fail("buffer"));
            } catch (error) {
              scope.failWith(
                error instanceof Error && error.name === "NvrError"
                  ? error
                  : failure("unsupported-codec"),
              );
            }
          } else if (data instanceof ArrayBuffer) {
            if (!sb) {
              scope.fail("buffer");
              return;
            }
            if (data.byteLength === 0) return;
            if (
              bytes + inFlight + data.byteLength > 4 * 1024 * 1024 ||
              queue.length >= 128
            ) {
              scope.fail("buffer");
              return;
            }
            queue.push(data);
            bytes += data.byteLength;
            pump();
          } else scope.fail("unsupported-api");
        });
        if (managed) {
          context.video.disableRemotePlayback = true;
          context.video.srcObject = ms as unknown as MediaStream;
        } else {
          const objectUrl = (options.createObjectURL ?? URL.createObjectURL)(
            ms,
          );
          scope.own(() =>
            (options.revokeObjectURL ?? URL.revokeObjectURL)(objectUrl),
          );
          context.video.srcObject = null;
          context.video.src = objectUrl;
        }
        send();
        void scope.play();
      } catch (error) {
        scope.close();
        throw error instanceof Error && error.name === "NvrError"
          ? error
          : failure("unsupported-api");
      }
    },
    async stop() {
      lifetime?.close();
      lifetime = undefined;
    },
    async setListening(enabled) {
      setLocalListening(lifetime, enabled);
    },
  };
}
export function setLocalListening(
  scope: MediaLifetime | undefined,
  enabled: boolean,
): void {
  if (!scope?.alive) return;
  const c: TransportStart = scope.context;
  if (enabled && !canListen(c)) throw failure("policy");
  c.video.muted = !enabled;
  if (enabled) void scope.play();
}
