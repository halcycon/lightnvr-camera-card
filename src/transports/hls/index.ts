import Hls from "hls.js";
import type { TransportAdapter, TransportStart } from "../../contracts";
import { failure } from "../../api/safety";
import { canListen, checkPolicy, MediaLifetime } from "../mse/lifecycle";
import { setLocalListening } from "../mse";
import { createAuthorizedLoader, mediaPath } from "./loader";

export interface HlsAdapterOptions {
  /** Injection point for the pinned bundled hls.js constructor; no remote scripts. */
  hls?: typeof Hls;
}
export function selectHlsProvider(c: TransportStart): "native" | "go2rtc" {
  const selected = c.config.hls.provider;
  // The client-config go2rtc flag describes global availability. Select once from
  // that policy; HTTP/WS failures never change the selected provider.
  if (c.capabilities.forceNativeHls === true) {
    if (selected === "go2rtc") throw failure("policy");
    return "native";
  }
  if (selected === "go2rtc") {
    if (c.capabilities.go2rtc === "denied") throw failure("policy");
    return "go2rtc";
  }
  if (selected === "native" || c.capabilities.go2rtc === "denied")
    return "native";
  return "go2rtc";
}
export function createHlsAdapter(
  options: HlsAdapterOptions = {},
): TransportAdapter {
  let lifetime: MediaLifetime | undefined;
  return {
    kind: "hls",
    async start(context) {
      lifetime?.close();
      lifetime = undefined;
      checkPolicy(context, "hls");
      const provider = selectHlsProvider(context);
      const listen = canListen(context);
      const urls = context.client.mediaUrls(context.source, listen);
      const url = provider === "native" ? urls.nativeHls : urls.go2rtcHls;
      if (!url) throw failure("configuration");
      mediaPath(context.client, url);
      const Engine = options.hls ?? Hls;
      // Match the pinned hls.js example: canPlayType('...') can report maybe
      // while native HLS still cannot decode this source. Choose the engine up front.
      const bundledPlayback = Engine.isSupported();
      // Native video cannot carry Basic headers or inspect redirects. Only the verified
      // same-origin scoped cookie proxy confines all browser-managed child requests.
      const cookieProxy =
        context.client.profile.auth === "session" &&
        context.client.profile.sameOrigin &&
        new URL(context.client.profile.baseUrl).pathname !== "/";
      const nativePlayback =
        !bundledPlayback &&
        cookieProxy &&
        Boolean(context.video.canPlayType("application/vnd.apple.mpegurl"));
      if (!bundledPlayback && !nativePlayback) throw failure("unsupported-api");
      const scope = (lifetime = new MediaLifetime(
        context,
        "hls",
        nativePlayback,
      ));
      if (!scope.alive) return;
      try {
        if (nativePlayback) {
          context.video.crossOrigin = "use-credentials";
          context.video.src = url;
          void scope.play();
          return;
        }
        // All request types, including keys and alternate renditions, use this loader.
        const loader = createAuthorizedLoader(
          context.client,
          scope.abort.signal,
          (error) => scope.failWith(error),
        );
        const policy = {
          default: {
            maxTimeToFirstByteMs: 10000,
            maxLoadTimeMs: 20000,
            timeoutRetry: null,
            errorRetry: null,
          },
        };
        const player = new Engine({
          loader,
          enableWorker: false,
          debug: false,
          maxBufferLength: 4,
          maxMaxBufferLength: 8,
          backBufferLength: 0,
          maxBufferSize: 8 * 1024 * 1024,
          liveSyncDurationCount: 2,
          liveMaxLatencyDurationCount: 6,
          lowLatencyMode: false,
          manifestLoadPolicy: policy,
          playlistLoadPolicy: policy,
          fragLoadPolicy: policy,
          keyLoadPolicy: policy,
          certLoadPolicy: policy,
          steeringManifestLoadPolicy: policy,
          interstitialAssetListLoadPolicy: policy,
        });
        scope.own(() => player.destroy());
        let recoveries = 0;
        player.on(Engine.Events.ERROR, (_event, data) => {
          if (!scope.alive) return;
          const status = data.response?.code;
          if (status === 401 || status === 403) {
            scope.fail(status === 401 ? "auth" : "policy", status);
            return;
          }
          if (!data.fatal) return;
          if (data.type === Engine.ErrorTypes.MEDIA_ERROR && recoveries++ < 1) {
            context.emit({ type: "state", state: "recovering" });
            try {
              player.recoverMediaError();
            } catch {
              scope.fail("buffer");
            }
          } else
            scope.fail(
              data.type === Engine.ErrorTypes.MEDIA_ERROR
                ? "unsupported-codec"
                : "network",
              status,
            );
        });
        player.on(Engine.Events.MANIFEST_PARSED, () => {
          if (scope.alive) void scope.play();
        });
        player.attachMedia(context.video);
        player.loadSource(url);
      } catch (error) {
        scope.close();
        throw failure(
          error instanceof Error && error.name === "NvrError"
            ? "configuration"
            : "unsupported-api",
        );
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
