# Architecture and frozen contracts (T1)

The browser card is a Lit custom element bundled as one ES module with hls.js. Home Assistant supplies layout and theme. The card uses the existing lightNVR HTTP service and managed go2rtc; it does not provision cameras or another media server. Contract exports live in `src/contracts/index.ts`.

## Ownership and boundaries

- T2 implements `NvrClient`/`NvrClientFactory`, normalization, session coordination and wire adaptation. No UI or adapter duplicates raw authentication. `Action` is a card capability vocabulary; T2 maps it to actual server grants (for example snapshot → `snapshot.create`). Unknown capabilities remain unknown and never imply permission. Server enforcement is authoritative.
- T4 implements `TransportAdapter` for WebRTC and `TalkController`; T5 implements MSE/HLS. `TransportStart` supplies the video, selected source, config, client, policy, abort signal and event sink. Setup completion does not mean playing; emit `first-frame` only after decoded/rendered video. An optional WebRTC sender is the only microphone path.
- T6 implements `PlaybackController`. Each card owns one active adapter, video and generation; a transition awaits talk shutdown and old-adapter stop. Shared profile login/start queues never share peer connections, video elements or microphones. Adapter stop, controller stop and dispose are repeat-safe. Visibility policies suspend resources without automatically resuming talk.
- T7 and T8 consume typed client/controller interfaces. Editor changes validate the entire configuration and emit complete events. Read-only advanced values must survive editing. Unknown config fields are rejected with Zod issue paths; they are never silently stripped. Wire schemas deliberately select credential-free inventory fields.

`NvrError.failure` carries a fixed safe message and typed code/status, never raw server text, URL, SDP or headers. Auth, policy and privacy denials are terminal for transport fallback. Source-offline uses backoff; it does not cycle renderers or refresh a server source. Controls are explicit typed operations against canonical camera names. Manual exact source overrides are not camera identities. A 202 recording acknowledgement remains `accepted`, requiring state confirmation.

## Configuration v1

`validateConfig(unknown)` returns the normalized `CardConfigV1`; serialize and revalidate to round trip. `version` defaults to 1. Root and all nested objects are strict. Tests include the plan's remote and prefixed server examples.

| Setting | Frozen meaning/default |
| --- | --- |
| `server` | HTTP(S) NVR root or same-origin absolute path; no userinfo, query, fragment or protocol-relative URL |
| `go2rtc_path` | Relative path, `go2rtc/`; segments limited to letters/digits/underscore/hyphen; trailing slash required |
| `username`, `password`, `credential_storage` | Optional credentials; dashboard (default) or session-only; session credentials supplied to client connect, never persisted |
| `auth` | `session` default; `basic` usable only for proven fetch routes; never invented WS/native-video headers |
| `stream`, `camera_uuid`, `profile`, `source` | Required canonical/manual selector, optional UUID; main default or sub; optional exact source override |
| `transports` | Unique nonempty ordered subset of webrtc/mse/hls; default all three. One entry means forced mode. No conflicting mode field |
| `hls.provider` | auto/default, go2rtc, native; auto honors server force-native/go2rtc availability; no switch around denial |
| `timeouts` | connection_ms=30000 (or inherit), ice_grace_ms=5000; optional webrtc_ms/mse_ms/hls_ms override connection deadline; integers 100–300000 ms |
| `retry` | base_ms=2000, cap_ms=30000, attempts=5, jitter=0.2; cap >= base, bounded attempts |
| `video.enabled` | true only. Audio-only cards explicitly deferred; false rejected |
| `audio` | enabled=true, listen=true, muted=true, microphone=false, talk_mode=ptt, volume=1; disabled requires listen=false and microphone=false; microphone requires WebRTC in order |
| `controls` | Optional booleans: speaker, microphone, fullscreen, snapshot, transport, profile, zoom, ptz, daynight, recording, privacy, detection, refresh_source, timeline. UI defaults viewer controls on where capable; privileged/privacy/refresh mutations off unless opted in |
| `layout` | aspect_ratio=16/9, object_fit=contain (or cover), fullscreen_main=false |
| `visibility` | hidden=pause, offscreen=pause; each may be continue. Both pause conditions must clear before resuming |
| `ice_servers` | Optional explicit RTCIceServer list (including empty list); omitted uses server ICE. Only stun/stuns/turn/turns URLs; optional username/credential; credentials redacted like login secrets |

Audio request is intersected with server instance policy and separate listen/talk grants. `listen` controls negotiation; `muted`/volume control local playback. Microphone configuration permits a control; it never acquires a device without a gesture. PTT is the default talk mode. Missing backend capability fields cannot override a denial.

`migrateLegacy()` creates a reviewable preview, never logs in. It accepts the actual `custom:webrtc-camera` input with server userinfo, exact `url`, mode, comma-separated media and ui flag, plus the historical media object shape. It decodes credentials once, strips userinfo, removes the trailing `/go2rtc/`, preserves the exact `front_door_sub` as `source` and `stream`, and keeps profile=main so no additional suffix is inferred. Video/audio/microphone intent survives. Other legacy extensions and audio-only input require explicit manual review. `ui:false` disables every listed control. No old custom-element tag is registered.

## Build and tests

Node 22.22.2/npm 11.8.0 are pinned. Vite 7.3.8 supports Node >=22.12 (also ^20.19); TypeScript 5.9.3 is the selected stable compiler, with no native TS7 requirement. Lit 3.3.1, hls.js 1.7.4, Zod 4.6.7, Vitest 4.1.12, YAML 2.9.1, happy-dom 21.0.4 and Playwright 1.56.1 are locked. Engine metadata was checked with `npm view` and installed versions with `npm ls --depth=0`.

`npm run build` targets T7's future `src/index.ts`. Workers set `LIGHTNVR_BUILD_DIR=/tmp/<task-specific-directory>`; the safe default is `/tmp/lightnvr-T1-build`, never shared dist. T1 verifies concrete compilation with `LIGHTNVR_BUILD_ENTRY=src/contracts/index.ts LIGHTNVR_BUILD_DIR=/tmp/lightnvr-T1-contract-build npm run build`. This contract-only output is not an installable card. Coordinator T10 alone may explicitly choose dist after integration. `check:release` verifies a single module, no remote static/dynamic imports or sourcemap, required files and HACS filename; real HACS installation remains T10 evidence.

Validation: `npm ci`, `npm run typecheck`, `npm run lint`, `npm run test:unit -- tests/contracts`. Real upstream probing is separate and fails with exit 2/INCOMPLETE without an isolated fixture. It never substitutes mocked responses for upstream proof. See [upstream receipt](upstream-contract.md).

Primary references checked: [Vite 7 runtime/build docs](https://v7.vite.dev/guide/), [TypeScript 5.9](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-9.html), [Home Assistant custom-card API](https://contributors.home-assistant.io/frontend/custom-ui/card/), [HACS plugin packaging](https://hacs.xyz/docs/publish/plugin/), [hls.js 1.7.4 API](https://raw.githubusercontent.com/video-dev/hls.js/v1.7.4/docs/API.md).


## Coordinator security update and transport handoff

After T2/T3 verification, dependency advisories required Zod 4.6.7, Vite 7.3.8,
Vitest 4.1.12 and typescript-eslint 8.72.2. npm 10.9.7 failed resolving the new
peer graph; npm 11.8.0 resolved it with Node 22.22.2. The current manifest/lockfile
are authoritative; the original T1 receipt retains its historical versions.
Nested object defaults now use Zod 4 prefaults so configuration defaults and
round trips stay unchanged. The scoped minimatch override affects only
@typescript-eslint/typescript-estree, preserving ESLint's legacy minimatch API.
YAML 2.9.1 supplies safe editor serialization; happy-dom 21.0.4 supplies DOM unit
tests. Install with `npx --yes npm@11.8.0 ci` when the system npm is older.

TalkController now has subscribe(listener) for immutable pending/active/error/
meter updates; PlaybackSnapshot carries the current talk state as well as the
existing talking boolean. This is needed for permission-pending UI and the local
meter without leaking a mutable microphone object into the UI. Stop/dispose and
late permission cancellation still own all device cleanup.

The new typed autoplay failure is a user-gesture condition, not evidence of a
broken transport. Adapters must cancel their first-frame deadline and report it
without fallback/retry loops. The controller retains the adapter in suspended
state; an explicit retry/play gesture resumes video.play() rather than opening
a second player. Never resume microphone transmission with that gesture.

The optional viewer_url config is an explicit NVR web-UI base for timeline/open links. The scoped API/media proxy intentionally does not expose lightNVR HTML/assets. UI links must be hidden unless viewer_url is configured or a direct, known external server root can be used; never imply that the restricted API prefix serves the whole NVR UI.
