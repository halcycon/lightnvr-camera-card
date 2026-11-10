# Plan: lightNVR camera card for Home Assistant

Execution baseline: implementation authorized on 2026-11-09 in a new project directory. A public repository and the approved Tailor scaffold now exist at https://github.com/halcycon/lightnvr-camera-card. Private process identities, quota recovery and command checkpoints are kept outside this repository.

Upstream reference: `opensensor/lightNVR`, main commit **8983888a19fef2040c48eee0a4ce56db5dafeb85**, web package version **0.48.0**. This is a research baseline, not a claim about the user's installed server. The deployed version/image tag was requested and remains unconfirmed. Implementation status and verification are recorded per task below; untested device and store behavior remains explicitly unclaimed.

Outcome: install a GitHub-hosted HACS Dashboard card; enter a lightNVR URL, username and password; discover authorized streams; select cameras; watch one per card or several in a Home Assistant grid; listen, use PTT or toggle talk where supported; configure WebRTC → MSE → HLS fallback and viewer controls. Reuse the go2rtc instance already managed by lightNVR. No Home Assistant go2rtc installation, camera registration, or source reconfiguration is required.

## Scope and decisions

Execution authorization: the user requested this plan be executed with a coordinator and up to two independent native Herdr workers, durable recovery, a public GitHub repository and Tailor layout. Repository creation, scaffold application and development pushes are authorized. A public release and default-catalog submission remain separate publication steps.

- Repository name: `lightnvr-camera-card`; custom element and YAML type: `custom:lightnvr-camera-card`; release file: `lightnvr-camera-card.js`. GitHub owner defaults to `halcycon` from workspace instructions; availability and public publication are execution-time checks. The repository is public; no default-catalog submission or tagged release has been made.
- Build a TypeScript browser custom element using Lit, bundled with Vite as one ES module, including hls.js. Pin tested versions in the lockfile during T1. Do not inherit lightNVR's entire Preact application, Tailwind, server administration, telemetry, or account-management UI.
- Copying/adapting lightNVR implementation code must preserve applicable upstream licensing and notices. Use GPL-3.0-compatible project licensing if deriving code; upstream's root LICENSE governs the review, despite the web package declaring ISC. Record copied versus independently written portions and dependency licenses in THIRD_PARTY_NOTICES.md.
- Native HA `grid`, `vertical-stack`, and `horizontal-stack` host individual cards. A discovery editor selects one camera for its card and can generate copyable YAML for selected cameras as separate cards or a native grid. The editor cannot silently insert sibling cards into the dashboard. A second custom grid component is unnecessary.
- Defaults: muted autoplay, inline video, PTT, no microphone acquisition until a deliberate gesture, ordered transports `[webrtc, mse, hls]`, connection timeout 30 seconds, ICE recovery grace 5 seconds, retry base 2 seconds / cap 30 seconds with jitter and bounded attempts before a visible retry state. Values are validated and configurable; prefer server timeouts when explicitly requested through an `inherit` setting. Playback reaches “playing” only on decoded/rendered media, not merely ICE connected, WS open, codec metadata, or a parsed playlist.
- Preserve server audio policy, privacy, permissions, and disabled transport flags. Server permissions remain authoritative even if an editor shows an unavailable control. A manual retry recreates only this card's player. “Refresh source” is a separate optional, explicitly labelled server action that may affect other viewers.
- Standard viewer controls are in scope, with the mapping below specifying parity. A full NVR management interface, recording browser/timeline, detection configuration, camera provisioning, arbitrary RTSP inputs, and a Python HA integration are outside this card's scope.

## Source findings: implemented upstream behavior

The following links are pinned so workers can reproduce research without trusting current `main`. Temporary research excerpts were saved under `/tmp/lightnvr-research`; they are disposable and are not a dependency of execution.

| Area | Observed contract | Evidence |
| --- | --- | --- |
| Inventory | Paginated `GET /api/streams?summary=true&surface=live&page=1&page_size=100&sort_by=name&sort_order=asc&availability=all`; walk `total_pages`, not just the first page. Live summaries include camera UUID/name, status, substream, backchannel, PTZ, privacy and playback preference fields. | [stream-summaries.ts](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/web/js/utils/stream-summaries.ts), [core.ts](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/web/js/types/core.ts) |
| Authentication | `POST /api/auth/login` accepts JSON username/password, establishes an HttpOnly `session` cookie, and returns success/redirect/password-change status. It does **not** return a bearer session token on normal login. TOTP can return a challenge. Cookies use `Path=/; SameSite=Lax`, and Secure when configured. HTTP Basic and other credential types exist in the server, but browser media requests have different delivery constraints. | [auth handler](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/src/web/api_handlers_auth_backend_agnostic.c), [httpd_utils.c](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/src/web/httpd_utils.c) |
| Client capabilities | `GET /api/client-config` exposes go2rtc availability, force-native-HLS, audio/transport disable flags, default transport and timeouts; `GET /api/ice-servers` supplies ICE configuration. Fields can be absent on older releases. | [settings-utils.ts](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/web/js/utils/settings-utils.ts), [mediaLifecycle.ts](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/web/js/api/mediaLifecycle.ts) |
| WebRTC | POST SDP to `/go2rtc/api/webrtc?src=<encoded source>` using `Content-Type: application/sdp`; current protocol documents 201 SDP answers (legacy variants can return 200). Bounded ICE gathering precedes POST; no invented HTTP trickle endpoint. Video is recvonly; audio is omitted, recvonly, or sendrecv according to audio/listening/backchannel policy. | [WebRTCVideoCell.tsx](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/web/js/components/preact/WebRTCVideoCell.tsx), [media protocol dispositions](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/docs/api/contracts/media-protocols.md) |
| Talk | Captures microphone with echo cancellation/noise suppression/auto gain; attaches using the negotiated audio sender's `replaceTrack(track)`; serializes attach/detach and stops stale permission results. Stop detaches and stops local tracks. Supports PTT and toggle, keyboard release and cancellation. | [push-to-talk.ts](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/web/js/utils/push-to-talk.ts), [keyboard helper](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/web/js/utils/push-to-talk-keyboard.ts), WebRTCVideoCell above |
| MSE | Same-origin WS `/go2rtc/api/ws?src=<encoded source>`; send `{type: 'mse', value: <supported codec list>}`; receive MIME negotiation and binary fMP4. Uses MediaSource or ManagedMediaSource. Current server rejects a browser Origin whose authority differs from Host. | [MSEVideoCell.tsx](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/web/js/components/preact/MSEVideoCell.tsx), [go2rtc_websocket.c](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/src/web/go2rtc_websocket.c) |
| HLS | go2rtc `/go2rtc/api/stream.m3u8?src=<source>&mp4=flac` (with video selector when audio disabled); alternatively native `/hls/<camera>/index.m3u8`. Upstream chooses native when forced or when go2rtc is disabled; it does not silently switch to native merely because enabled go2rtc failed. Browser native HLS or bundled hls.js handles playback. | [HLSVideoCell.tsx](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/web/js/components/preact/HLSVideoCell.tsx) |
| Fallback | Auto starts from the selected/default renderer: WebRTC → MSE → HLS, MSE → HLS, or HLS alone. Fixed profiles include webrtc_only, mse_only, hls_only, webrtc_then_mse, mse_then_hls. Offline-source errors stay on backoff instead of cycling renderers. | [playback-transport.ts](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/web/js/utils/playback-transport.ts), [PlaybackTransportCell.tsx](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/web/js/components/preact/PlaybackTransportCell.tsx) |
| Authorization | `live.view`, `audio.listen`, and `audio.talk` are separate actions intersected with instance audio policy. Current go2rtc is a maintained opensensor fork with media leases, HLS session credential binding and ongoing revocation. `/go2rtc/api/streams` is administrative diagnostics and can expose source information; it is not viewer discovery. | [media authority evidence](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/docs/api/contracts/media-authority-evidence.md), media dispositions above |

Source comments can lag code: WebRTCVideoCell contains an old comment describing the proxy as HTTP-only, while current MSE and server code implement authenticated WebSockets. Prefer executable code and protocol evidence. Do not assume upstream AlexxIT/go2rtc `master` is the managed fork's exact contract.

## Connectivity and credential design: prerequisite, not a UI afterthought

**The bare remote URL + password experience is conditional on browser-accessible authentication and proxy support.** It cannot be promised for every lightNVR release or HA access URL by frontend code alone.

1. Full-support reference topology: expose an isolated prefix such as `https://ha.example.test/lightnvr/front/` through the reverse proxy serving the HA dashboard, forwarding to **lightNVR's HTTP service**, including its `/go2rtc/` routes. Login and every media request use this prefix and lightNVR's session cookie. Preserve the public Host consistently with browser Origin; verify TLS forwarding and CSRF behavior. No direct public forwarding to port 1984, which would bypass lightNVR permissions/media authority.
2. T1 proves the topology with browser traffic; T3 supplies a reproducible proxy recipe. A simple Traefik StripPrefix alone is not assumed sufficient: absolute HLS child paths, cookie Path/Domain, duplicate cookies, Location, WS upgrade, and native HLS requests must stay within the selected prefix. If required, an example nginx routing helper behind Traefik handles response/cookie/playlist rewriting; this is proxy configuration, not another media server. Lock the tested recipe before dependent transport work.
3. Isolate session cookies by NVR prefix, forward only the selected NVR's cookies upstream, and prevent NVR cookies from reaching HA routes. Keep live go2rtc HLS session IDs bound to the same session credential through every playlist/init/segment request. Multiple cards for one NVR/user share an in-memory login coordinator; a profile cannot silently switch another card's identity. Two different users against one identical cookie scope are rejected with a clear configuration error; separate proxy scopes are required.
4. Direct `https://nvr.example.test/` is accepted as a configuration target, with diagnostics for CORS, cookie delivery, WebSocket origin, preflight, and media support. HTTP Basic can be used for supported fetch-based routes if verified; it does not magically authenticate browser WS or native video requests. The WebSocket constructor accepts URL/protocols, not an Authorization-header option. Do not add fake headers, rely on credential URL userinfo, or add passwords to query strings. Native HLS cannot accept arbitrary headers; use a proven cookie session or report the limitation.
5. Current upstream's WS same-origin check blocks ordinary direct cross-origin MSE. Adding CORS headers does not change that. Do not weaken origin checks, inject a shared administrator credential, rewrite Origin without a validated edge policy, or expose unauthenticated go2rtc to make it work. An upstream origin/auth enhancement or optional HA backend proxy could later improve zero-configuration connectivity; neither is silently added to this card plan. Unsupported direct topology must offer the reference setup instructions, and cannot count as full support.
6. Discover through lightNVR's credential-free live summary endpoint. Older supported servers may use a separately tested compatibility adapter; sanitize any legacy full stream response immediately and never log/store RTSP or camera credentials. Manual exact source entry is supported after a successful inventory response; missing discovery currently blocks playback because a proxy error cannot safely establish a missing upstream route. Older-server compatibility remains untested. Do not request administrator rights just to list go2rtc sources.
7. Normalize the user's existing `server: https://USER:PASS@nvr.example.test/go2rtc/` + `url: front_door_sub` migration: extract credentials once, remove userinfo from all outgoing URLs, derive NVR root and go2rtc prefix, preserve the exact source `front_door_sub`. For discovered cameras store canonical name/UUID and main/sub profile; add `_sub` only for a verified managed substream, never twice. Explicit manual source overrides are not converted into invented camera names for control APIs.
8. Mask editor passwords; redact URLs, headers, SDP and upstream errors in diagnostics. Credentials saved in Lovelace YAML are visible to users who can read dashboard configuration; a password input is not a vault and `!secret` is not promised for UI-managed dashboards. Offer session-only credentials for users who accept reauthentication. No extra localStorage credential/session cache. Never log in using the supplied production credentials during planning.
9. Handle login 401, policy 403, forced password change, TOTP challenge, expired session, login rate limit, proxy HTML response, 502/503 and timeout distinctly. Single-flight reauthentication must be bounded; authorization denials never trigger fallback to another route. TOTP may be completed interactively with an ephemeral code; persistent OTP seeds and unattended MFA bypass are excluded.

## Viewer control mapping

“All controls” here means accounting for each live-view affordance and its integration boundary; it does not imply embedding the entire NVR application. T7 implements the in-card controls in this table, and links out for the existing timeline.

| lightNVR control | Card behavior |
| --- | --- |
| Speaker/listening | Mute/unmute, explicit autoplay-unblock action, optional volume. Independent of microphone. Respect `audio_disabled` and listen rights; renegotiate/request audio only when needed. Available on any transport with a supported authorized audio codec. |
| Microphone | WebRTC only, capability/permission/secure-context gated; clear permission-denied/no-device/insecure-context messages; active microphone state and optional local level meter. Never start merely because the card mounts. |
| PTT / toggle | PTT by default, optional toggle. Pointer capture and keyboard Space/Enter scoped to focused control; stop on pointerup/cancel/lost capture, blur, hidden document, disconnect, reconfigure, transport change and card removal. Late permission results are stopped. Never resume talking automatically after reconnect. |
| Transport/status | Active WebRTC/MSE/HLS label, fallback reason, loading/offline/auth/privacy states, configurable renderer order and force-one selection. MSE/HLS disable talk with an explanation. No parallel hidden WebRTC talk connection. |
| Fullscreen and source | Fullscreen, main/sub selection, optional main upgrade in fullscreen and local fallback to sub on failed upgrade. Ordinary grids default to configured/sub profile; no server source mutation. Graceful behavior when fullscreen APIs are unavailable. |
| Zoom | Local digital zoom/pan/reset; camera-specific fisheye/dewarping stays in the NVR web UI. Keep digital zoom distinct from motorized PTZ. |
| Snapshot | Explicit permission-aware snapshot using `/go2rtc/api/frame.jpeg?src=...` where available; local canvas only when authorized and origin-clean, without bypassing snapshot permissions. Download filename uses camera/time and no credentials. |
| PTZ | Capabilities, directional hold/release, zoom, speed, stop, home, preset selection; optionally authorized preset save/set-home with confirmation. Stop on lost interaction or lifecycle interruption. Use canonical camera name. |
| Day/night | Capability-gated automatic/day/night via `GET/PUT /api/streams/{name}/daynight`; report server result and failures. |
| Manual recording | Explicit start/stop through `/api/streams/{name}/recording`; read current state first. Respect 202 start acknowledgement versus actual running state. |
| Privacy pause/resume | Optional permission-gated `PUT /api/streams/{name}` with `set_privacy_mode`; confirm global effect, refresh state after ambiguous completion, stop all local media/talk while private. |
| Detection overlay | Optional read-only overlay from `/api/detection/results/{name}`, align coordinates to source/aspect ratio, bound polling and stop when hidden. No detection configuration or annotation editor. |
| Retry / force refresh | Separate local retry and privileged source refresh (`POST /api/streams/{name}/refresh`); refresh has an explicit shared-impact confirmation and is off by default. No automatic refresh/restart/reload. |
| Timeline link | Optional “Open in lightNVR” / timeline deep link using the confirmed server route and encoded camera identity; no embedded recording browser. |

Reference controls: [WebRTCVideoCell](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/web/js/components/preact/WebRTCVideoCell.tsx), [PTZControls](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/web/js/components/preact/PTZControls.tsx), [device API](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/web/js/api/device.ts), [media lifecycle API](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/web/js/api/mediaLifecycle.ts).

## Configuration contract

The frozen schema in `src/contracts/config.ts` defines exact defaults and editor round-trip rules; examples are validated against it. `server` means NVR root; `go2rtc_path` defaults to `go2rtc/` relative to it. Absolute remote root and same-origin proxy prefix are both representable. Optional advanced fields include exact source override, HLS provider (`auto`, `go2rtc`, `native`), per-transport timeouts, retry settings, audio/video enable flags, controls visibility, aspect ratio/object fit, playback_visibility policy and ICE override. Native HA visibility conditions and grid/layout metadata round-trip separately without restarting playback. Invalid combinations are rejected, not silently coerced.

```yaml
type: custom:lightnvr-camera-card
server: https://nvr.example.test/
username: camera_viewer
password: REPLACE_WITH_YOUR_PASSWORD
stream: front_door
profile: sub
transports: [webrtc, mse, hls]
audio:
  listen: true
  muted: true
  microphone: true
  talk_mode: ptt
controls:
  speaker: true
  microphone: true
  fullscreen: true
  snapshot: true
```

For the full-support proxy topology replace `server` with `/lightnvr/front/` on the HA origin. The direct example above requires verified cross-origin support and may need that proxy change for MSE/native HLS. TLS alone does not solve origin/authentication constraints. Native HA grid example:

```yaml
type: grid
columns: 2
square: false
cards:
  - type: custom:lightnvr-camera-card
    server: /lightnvr/front/
    username: camera_viewer
    password: REPLACE_WITH_YOUR_PASSWORD
    stream: front_door
    profile: sub
    transports: [webrtc, mse, hls]
  - type: custom:lightnvr-camera-card
    server: /lightnvr/front/
    username: camera_viewer
    password: REPLACE_WITH_YOUR_PASSWORD
    stream: driveway
    profile: sub
    transports: [webrtc, mse, hls]
```

Do not publish the user's real host/credentials in examples, screenshots, fixtures or workflow output. New YAML uses separate credential fields; old userinfo URLs are migration input only.

## Interfaces to freeze in T1

- `CardConfigV1` and strict validation/migration; normalized `ServerProfile` and credential/session scope.
- `CameraSummary`: canonical name, optional UUID, exact playable main/sub sources, status, privacy and known/unknown capability states. UUID supports safe rename refresh; names remain the wire selectors required by current routes. Never guess a renamed camera.
- `NvrClient`: connect/login/verify/discover/clientConfig/iceServers, permission-aware control requests, authorized fetch and normalized media URLs. It must not pretend fetch headers can be passed to WebSocket or HTMLVideoElement.
- `TransportAdapter`: start with video element/source/capabilities/AbortSignal, typed events (`first-frame`, `failure`, `state`), idempotent stop, listening change and optional WebRTC audio sender. Typed failures distinguish auth/policy/privacy, source offline, unsupported codec/API, network/ICE, timeout, and buffer errors.
- `TalkController`: explicit start/stop, cancellation token, serial sender operations and local track cleanup. `PlaybackController` owns adapter choice, generations, recovery and talk shutdown. Only one adapter owns a card's video element at a time.
- UI/editor consume these contracts; they do not call raw fetch independently. Tests use an injectable client/transport factory and owned generated media. Contracts and package manifests have one writer, T1; later changes go through the coordinator between waves.

## Dependency-aware execution tasks

Every task starts Pending. The coordinator alone maintains status/log/file records below and integrates changes. Workers report changes and evidence; they do not edit this plan, integration docs, the shared Git index, or commit concurrently. All paths are relative to the project root unless absolute. A directory ownership grant below is exclusive and does not include sibling directories.

### T1: Establish project, contracts and browser connectivity proof
- **depends_on**: []
- **owns**: `package.json`, `package-lock.json`, `.nvmrc`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `eslint.config.js`, `.gitignore`, `src/contracts/`, `tests/contracts/`, `tests/probes/`, `tests/fixtures/contracts/`, `scripts/probe-connectivity.mjs`, `scripts/check-release.mjs`, `docs/architecture.md`, `docs/upstream-contract.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`.
- **reads**: this plan; pinned source links; installed lightNVR version when supplied; official HA/HACS/hls.js/proxy docs below; parent workspace instructions.
- **description**: Set up typed custom-card build/test scripts and freeze the interfaces above. Pin tool versions compatible with the actual local Node runtime, checking primary docs; upstream uses Node >=26.13 <27, TypeScript 6 plus native TS7 tooling, Vite ^8.3.6, Lit is a new card dependency, and hls.js ^1.7.4. Do not blindly copy upstream's toolchain. Prove normal login cookie, Basic-fetch possibilities, inventory response, SDP answer status/body, WS origin rejection, and HLS child paths using an isolated server/proxy fixture at the upstream commit. Record a supported-version matrix. Use local fixture credentials/generated sources; no production writes or camera control.
- **acceptance**: Contracts and scripts are concrete and buildable; normal login is not modelled as a token response; current cross-origin limitations are reproduced; one feasible full-support proxy design is documented for T3 to package. Older deployed versions remain explicitly unverified until observed. If proof requires a server change or HA integration, mark that as a blocker instead of assigning dependent implementation on a fictional contract.
- **validation**: `npm ci`; `npm run typecheck`; `npm run lint`; `npm run test:unit -- tests/contracts`; `npm run test:probe`. Expected: schema/migration round trips pass; browser evidence distinguishes direct rejection from same-origin success and captures endpoint/status/content-type without credentials. `npm run test:probe` must fail or clearly mark incomplete when the real isolated server is absent; mocks alone cannot verify the upstream contract.
- **status**: Verified
- **log**: Coordinator verified contracts, temporary build and 19 real browser connectivity assertions against official lightNVR 0.48.0. Exact tested image/research revision distinction is documented in docs/upstream-contract.md.
- **files edited/created**: package/tool configs and lockfile; src/contracts; tests/contracts, tests/probes, tests/fixtures/contracts; scripts/probe-connectivity.mjs and check-release.mjs; LICENSE and THIRD_PARTY_NOTICES.md; docs/architecture.md and upstream-contract.md.

### T2: Authentication, discovery and lightNVR API client
- **depends_on**: [T1]
- **owns**: `src/api/`, `tests/unit/api/`.
- **reads**: `src/contracts/`, T1 upstream receipt, upstream auth/streams/device APIs.
- **description**: Implement normalized base/prefix URLs; session and tested Basic-fetch modes; redaction; single-flight bounded authentication; optional interactive MFA; capability and paginated authorized inventory; explicit manual source mapping; typed control APIs for T7. Support response cancellation and sanitized errors, including non-JSON go2rtc failures. Cache discovery/config per credential scope with refcounts and bounded lifetime; share no camera player/peer connection or microphone.
- **acceptance**: Connect → discover → select is possible with viewer privileges; >100 streams work; empty authorized inventory differs from auth failure; literal `front_door_sub` and derived sub profile remain distinct; passwords with reserved/non-ASCII characters survive supported encoding. Same cookie scope cannot switch identities silently; 401 reauth is bounded, 403 is terminal, offline remains recoverable. Permission unknown is represented honestly.
- **validation**: `npm run test:unit -- tests/unit/api`; `npm run typecheck`. Evidence includes multi-page discovery, stale request cancellation, changed credentials, root/subpath joining, challenge/locked account/rate limit, 401/403/HTML/502, source mapping and credential-redaction tests.
- **status**: Verified
- **log**: 103 focused API tests, typecheck and lint passed. Cookie authentication, bounded discovery/reauthentication, canonical identity and terminal policy failures reviewed; MFA and native-HLS limits documented.
- **files edited/created**: src/api/{client,index,mapping,safety}.ts, src/api/README.md; tests/unit/api/{client,paths-controls}.test.ts.

### T3: Package and verify proxy connectivity recipes
- **depends_on**: [T1]
- **owns**: `examples/proxy/`, `docs/connectivity.md`, `tests/proxy/`.
- **reads**: T1 proven topology, upstream auth/WS/HLS source, official proxy docs.
- **description**: Produce tested Traefik-fronted same-origin routing examples to the existing NVR, with a narrowly scoped routing helper only if necessary. Cover prefix routing, public Host/Origin, trusted TLS forwarding, session cookie isolation, HLS URI/Location rewriting, upgrades, and all selected transport endpoints. Document direct mode's observed support and failures, and behavior under internal/external/Companion HA URLs.
- **acceptance**: Browser can log in, discover, open authenticated WS, obtain SDP, and request master/media playlists/init/segments under its NVR prefix. Two NVR prefixes do not share cookies. Requests to HA routes do not carry NVR cookies; unauthorized media and hostile origins remain rejected. No public raw go2rtc access or administrator injection. Exact supported proxy versions recorded. If existing HA origin cannot be routed, state the deployment prerequisite rather than claiming the NVR-side TLS sidecar is sufficient.
- **validation**: `npm run test:proxy`; `docker compose -f examples/proxy/compose.test.yaml config`. Isolated fixtures and actual upstream smoke check cover nested paths, encoded stream names, native HLS and go2rtc HLS, TLS and WS upgrade, cookie collisions, denied origins, and session expiry. T3 owns its Docker project and ports; never modify the user's running sidecar.
- **status**: Verified
- **log**: Both real HTTPS/WSS Traefik/helper suites passed with 28 assertions. Upstream media-auth cache observed at approximately 30 seconds; immediate revocation is not claimed.
- **files edited/created**: examples/proxy routing helper, production/test Compose and Traefik configs; tests/proxy harness/spec/types/receipt; docs/connectivity.md.

### T4: WebRTC adapter and microphone/talk lifecycle
- **depends_on**: [T2, T3]
- **owns**: `src/transports/webrtc/`, `src/audio/`, `tests/unit/webrtc/`, `tests/unit/audio/`.
- **reads**: shared contracts/API, verified connectivity receipt, upstream WebRTC/PTT/ICE helpers and race tests.
- **description**: Implement HTTP SDP signaling, bounded complete ICE gathering, server ICE settings with optional override, supported codec preferences and no invented HTTP candidate API. Negotiate the audio sender when talk is enabled/authorized; capture on gesture and attach/detach safely. Handle restart/cancellation, first decoded frame, ICE grace, permission/secure-context failure, remote track end and stats.
- **acceptance**: Video and listen work independently; PTT and toggle send only while requested. Stop/release before permission resolves never sends later; reconnect cannot attach to an old or replacement peer accidentally; failure/unmount stops every local track and meter. No automatic microphone restart. TLS error includes HA document origin and NVR signaling context. Audio disabled overrides card config.
- **validation**: `npm run test:unit -- tests/unit/webrtc tests/unit/audio`; `npm run typecheck`. Include delayed and denied permission, sender attach rejection, rapid press/release, overlapping starts, release during attach, stale sender, missing microphone, no secure context, no-video despite ICE success, timeout and aborted SDP-body cases. Real decoded media and camera talk are verified separately in T10.
- **status**: Verified
- **log**: 75 focused WebRTC/audio tests passed. Late capture cancellation, sender leases, independent speaker state and meter cleanup reviewed. Actual generated WebRTC decode passed separately; physical talk remains untested.
- **files edited/created**: src/transports/webrtc/, src/audio/, tests/unit/webrtc/, tests/unit/audio/.

### T5: MSE and HLS adapters
- **depends_on**: [T2, T3]
- **owns**: `src/transports/mse/`, `src/transports/hls/`, `tests/unit/mse/`, `tests/unit/hls/`, `tests/fixtures/media/`.
- **reads**: shared contracts/API, proxy receipt, upstream MSE/HLS components and protocol dispositions, pinned hls.js API.
- **description**: MSE/ManagedMediaSource codec negotiation and bounded binary append queues, live buffer trim/quota recovery and authenticated WS lifecycle. HLS uses native playback where supported with proven cookie auth, otherwise bundled hls.js with authorized requests for every manifest/segment. Implement explicit HLS-provider policy matching server force-native settings, browser feature detection, first-frame deadline and bounded recovery.
- **acceptance**: Both fallback transports render real generated media; speaker works when codec and rights permit; neither exposes talk. MSE buffer growth is bounded and object URLs are revoked. HLS child URLs retain prefix and session; credentials never leak to an arbitrary manifest origin/redirect. HLS-provider selection does not silently bypass denied go2rtc or change a server source. Cleanup destroys loaders, WS, SourceBuffers, callbacks and timers.
- **validation**: `npm run test:unit -- tests/unit/mse tests/unit/hls`; `npm run typecheck`. Cover codec rejection, binary-before-negotiation, append overflow, quota error, missing API, WS close/origin denial, HLS 404/401/403, master-to-child paths, credential-preserving init/segment loads, stream-ID restart and lifecycle destruction. T10 validates real browser rendering.
- **status**: Verified
- **log**: MSE/HLS tests and actual generated 1920-wide decode passed. Real Chromium testing corrected upfront hls.js selection and zero/zero full-resource range handling; opaque possible denials remain terminal.
- **files edited/created**: src/transports/mse/, src/transports/hls/, tests/unit/mse/, tests/unit/hls/, tests/fixtures/media/.

### T6: Playback orchestration, fallback and multi-card resource limits
- **depends_on**: [T4, T5]
- **owns**: `src/playback/`, `tests/unit/playback/`.
- **reads**: shared contracts, completed adapters, upstream playback-transport policy.
- **description**: Integrate adapters behind a per-card state machine with configurable order/fixed transport, capability filtering, deadlines, typed failure decisions, retries/backoff, manual retry and generation cancellation. Add a shared startup semaphore (default two concurrent starts per NVR profile, bounded wait/cancellation), visibility suspension and refcounted API usage. Each card owns its video and media resources.
- **acceptance**: Default WebRTC → MSE → HLS progression; forced mode never changes transport; skip known unsupported renderer; auth/privacy/source-offline failures get appropriate handling rather than cycling. Transition stops talk and releases the old adapter before starting the next. Restart and config change cannot resurrect a stale stream. HA `hass` updates do not restart healthy playback. Removing one card preserves other cards, shared sessions and queued starts.
- **validation**: `npm run test:unit -- tests/unit/playback`; `npm run typecheck`. Fake-clock evidence for fallback order, deadlines/retry exhaustion, offline backoff, 401/403, hide/show, 10-card startup fairness, cancellation, same-source independence and resource release. No automated source-refresh request is emitted.
- **status**: Verified
- **log**: Playback lifecycle tests passed. Bounded cleanup, FIFO admission, autoplay, visibility and independent cards reviewed. Manual source playback still requires successful inventory; unsupported older discovery is not bypassed.
- **files edited/created**: src/playback/ and tests/unit/playback/.

### T7: Home Assistant card and capability-aware viewer controls
- **depends_on**: [T6]
- **owns**: `src/card.ts`, `src/index.ts`, `src/ui/`, `tests/unit/card/`, `tests/unit/controls/`.
- **reads**: all shared contracts, API/playback/audio implementations, control mapping in this plan, official HA custom-card API.
- **description**: Register the custom element and `window.customCards`; implement `setConfig`, `hass`, connect/disconnect lifecycle, card sizing and supported Sections grid options; render themed responsive video and the mapped viewer controls. Provide focus/touch-accessible PTT, active-mic indicator, local meter, capability-aware PTZ/day-night/snapshot/recording/privacy/detection and lightNVR links. UI invokes typed clients/controllers, not duplicated authentication or raw player code.
- **acceptance**: Works in panel, masonry and native HA grid/stack layouts; controls are individually configurable and clear about unsupported/denied capabilities. Speaker and microphone have independent states. All interaction exits stop talk and PTZ; server-wide actions require the stated confirmation and never run as recovery. Large and small cards remain usable, theme-aware and keyboard accessible. Local snapshot cannot bypass snapshot permissions or tainted canvas restrictions.
- **validation**: `npm run test:unit -- tests/unit/card tests/unit/controls`; `npm run typecheck`; `npm run lint`; `npm run build`. Cover config changes during pending login/media, repeated hass updates, lifecycle teardown, keyboard/pointer cancellation, control capability matrix, denied mutations, polling suspension and scoped DOM IDs. Human browser checks remain in T10.
- **status**: Verified
- **log**: Full 511-test suite including 120 card/control tests, typecheck, lint and full bundle passed. Native HA metadata stays separate from playback identity. Actual current/legacy HA layout/editor/media checks passed; physical controls remain untested.
- **files edited/created**: src/card.ts, src/index.ts, src/ui/, tests/unit/card/, tests/unit/controls/; coordinator serialized shared config/editor/playback HA compatibility changes.

### T8: Visual connection/discovery editor and YAML migration
- **depends_on**: [T2]
- **owns**: `src/editor/`, `tests/unit/editor/`.
- **reads**: frozen config/contracts, API client, HA editor documentation, proposed YAML above.
- **description**: Implement `getConfigElement` editor element and stub/default config helpers, with connect → test → discover → select flow, main/sub preview choices, settings for transports/timeouts/retry/HLS/audio/talk/controls/layout and multi-selection YAML generation. Preserve unedited advanced options and emit complete `config-changed` events. Import the old server/url/mode/media/ui shape through explicit migration preview; never register the existing card's tag.
- **acceptance**: Single camera can be selected and saved without YAML; multi-selection produces valid separate-card or native-grid YAML; connection errors and unavailable capabilities are actionable. Passwords are masked, imported userinfo is removed, and previews never acquire microphones or issue control mutations. Async discovery cannot overwrite later edits. Unknown advanced fields survive round trip or are explicitly rejected with a useful message.
- **validation**: `npm run test:unit -- tests/unit/editor`; `npm run typecheck`. Cover >100 cameras, empty inventory, disabled/privacy streams, cancellation, bad credentials, migration of exact `front_door_sub`, secret redaction, full config event, forced transport/fallback validation and generated grid parsing. T7 wires the lazy editor import to the helpers after this task is verified.
- **status**: Verified
- **log**: 49 editor tests in the final combined suite passed. Discovery, session credential omission, exact migration, complete config events and ICE-preserving secret-redacted YAML reviewed. Actual HA discovery/editor/grid export passed.
- **files edited/created**: src/editor/{config,model,index}.ts; tests/unit/editor/editor.test.ts.

### T9: HACS packaging, user documentation and release preparation
- **depends_on**: [T3, T7, T8]
- **owns**: `hacs.json`, `.github/`, `README.md`, `docs/configuration.md`, `docs/tls-and-two-way-audio.md`, `docs/troubleshooting.md`, `docs/hacs-release.md`, `docs/images/`, `examples/cards/`.
- **reads**: built implementation/config contract, connectivity receipt, licensing notices and official HACS requirements.
- **description**: Prepare CI and tag-triggered release workflow that build/test and attach `lightnvr-camera-card.js`; no remote imports/CDN runtime dependencies. HACS filename must match repository name; choose a documented release-asset strategy and verify branch fallback behavior. Write GitHub/HACS custom-repository and manual `/local/` install, resource registration/cache-refresh, editor, single/panel/grid YAML, exact migration mapping, configuration reference and supported server/browser matrix. Add real sanitized screenshots and marketplace submission checklist.
- **acceptance**: Clear prominent statement: **Two-way audio requires Home Assistant to be opened in a secure context (normally trusted HTTPS), microphone permission, HTTPS/WSS media signaling for the HTTPS dashboard, and a compatible camera with lightNVR backchannel enabled and talk permission. A Traefik TLS sidecar can provide HTTPS to the NVR; it does not by itself secure the HA document or solve cross-origin MSE.** Document localhost exception without promising arbitrary HTTP LAN support. Explain speaker autoplay restrictions, NAT/ICE reachability (TLS reverse proxy is not TURN and does not relay WebRTC UDP), fallback latency/talk loss, credentials visibility, old-server capability limits and internal/external HA URLs. HACS default marketplace inclusion is a separate reviewed submission; custom-repository install must work first.
- **validation**: `npm run build`; `npm run check:release`; `npm run lint`; YAML examples parse against the frozen schema. CI runs `hacs/action` for category plugin using its documented current inputs (pin reviewed versions during execution). Inspect bundle/import graph and release contents; test manual and HACS custom-repository installation in T10. No public release or marketplace PR is submitted by this preparation task.
- **status**: Verified
- **log**: Verified metadata, documentation, screenshots, CI/release workflows and digest-pinned HACS validation action. Four example card instances passed the frozen schema. Temporary bundle, local packaging/checksums, actionlint and exact HACS filename-selection cases passed. Authenticated store installation/upgrade is not tested.
- **files edited/created**: hacs.json; README; .github/actions/hacs and card workflows; docs/configuration.md, tls-and-two-way-audio.md, troubleshooting.md, hacs-release.md, images; examples/cards.

### T10: Coordinator integration and acceptance evidence
- **depends_on**: [T7, T8, T9]
- **owns**: `tests/e2e/`, `docs/verification.md`, `docs/HANDOFF.md`, `dist/`, `lightnvr-camera-card-plan.md`; coordinator-only Git staging/index and final integration.
- **reads**: every task report/diff; isolated fixture and real-server receipts; actual HA, HACS, browser and NVR versions.
- **description**: Integrate lazy editor export/card registration, run combined tests/build, inspect every owned diff, create release artifact locally and record acceptance. Use generated local media plus a real isolated lightNVR/current managed fork for protocol tests; separately validate installed-version support and physical microphone/speaker behavior when a test camera is available. Record each result as pass/fail/not tested with exact versions and no secrets. Make only narrowly scoped integration fixes; return ownership-specific changes to the original worker after its peers stop.
- **acceptance**: Checklist below is evidenced. Missing camera/browser/server access is a visible release blocker for affected support claims, not a synthetic pass. No production server/sidecar/dashboard changes occur without an execution request covering them. Remote repository creation, public release and marketplace submission require the user's publication instruction; this plan alone authorizes none of those writes.
- **validation**: `npm ci`; `npm run typecheck`; `npm run lint`; `npm run test:unit`; `npm run test:probe`; `npm run test:proxy`; `npm run test:e2e`; `npm run build`; `npm run check:release`. Execute resource-intensive Docker/browser suites sequentially. Record HACS installation/upgrade/resource-load evidence from a test HA instance and the real camera checklist below.
- **status**: Verified
- **log**: Coordinator completed npm ci, typecheck, lint, 511 unit tests, 19 actual protocol checks, both proxy suites, public Playwright acceptance on fresh HA2026.10.4/2026.11.1 (13 named checks each), final bundle/release checks and public handoff. Complete notices are embedded in the single JS. Store authentication, physical talk and untested device/soak claims remain explicitly blocked; see docs/verification.md. Hosted publication checks are available on the repository Actions page.
- **files edited/created**: tests/e2e; docs/verification.md and HANDOFF.md; final dist module; plan; serialized Vite/release-check integration and two-source fixture provisioning.

## Waves, ownership and scheduling

Bound: at most **two implementation workers** plus coordinator. If executed using Herdr, use one labelled full-size tab per worker in the same workspace/cwd, a separate coordinator tab and a reusable **Agent control** board tab. No splits, worktrees, other workspaces, invisible agent backends, recursive delegation or model changes are requested. Execution used only the explicitly authorized native workers.

Suggested waves (start only after prerequisites are coordinator-verified):

1. T1 alone; resolve the browser/proxy proof before expensive implementation.
2. T2 and T3 concurrently; they share read-only contracts and own separate files.
3. T4 and T5 concurrently; T8 is eligible after T2 but waits for a worker slot.
4. T6 and T8 concurrently.
5. T7 alone.
6. T9 alone.
7. T10 coordinator integration.

Any bounded task subset includes unfinished prerequisites. Only T1 writes shared contracts/manifests/lockfile/tool configs. If a later task needs a package or interface change, the coordinator pauses affected workers, applies/reviews it, verifies compatibility, and resumes with updated context. Only T10 writes generated `dist/` deliverables after workers stop; workers may build to task-specific temporary output directories configured by T1. Workers must not overwrite a shared dist, install concurrently, share a test fixture DB, reuse Docker project/ports, or run full integration browser suites concurrently. Allocate unique unit-test reports/temp paths per worker. T3 owns its proxy runtime until its tests finish; T10 later reuses it exclusively.

## Durable execution and recovery

The explicitly requested parallel-task-herdr skill governs native workers, exclusive file ownership, independent verification and durable gates. The coordinator keeps prompts, worker identities, monitor state and recovery checkpoints in a private journal outside Git. Workers stop on holds or stale monitor checks; resume reconciles actual edits and commands before eligible work continues. No worktree reset, model/account switch or blind task replay is part of recovery. Private quota-reset automation is authorized for this run and never treats elapsed time as proof of capacity.

## Integration acceptance matrix

| Scenario | Required evidence |
| --- | --- |
| Installation | Local release bundle installs as HACS Dashboard custom repo and manual module; fresh load/upgrade registers the card once; no go2rtc/add-on gets installed. Marketplace PR package is prepared separately. |
| Connection | URL/user/password discovery at the tested NVR version; real same-origin proxy browser traffic passes; direct-origin limitations are detected correctly; restricted account sees only authorized cameras. |
| Layout | One panel card, two independent cards for the same source, different cameras in native grid/stack, resize, edit/save/reload, frequent hass updates and card removal. |
| Real media | Decoded first frame and authorized speaker audio via forced WebRTC, forced MSE, hls.js HLS, and native Safari HLS; capture codec/provider/versions. Header-only or mocked playback does not count. |
| Fallback | Disable/drop ICE → MSE; fail WS/codec → HLS; force-one remains forced; unsupported browser skips renderer; offline camera backs off; no fallback around 401/403/privacy; fallback visibly removes talk. |
| Talk | Physical compatible camera speaker receives PTT/toggle audio over trusted HTTPS; listen and talk independently; denied/no microphone/insecure HA document errors; quick release before permission, release outside button, keyboard repeat, hide/blur, reconnect and unmount leave no active microphone. Use a second observer or recording at the test camera to establish actual backchannel reception. |
| Controls | Capability/permission checks for mapped controls; PTZ release/stop; recording state versus accepted mutation; privacy shared effect; snapshot download and canvas/CORS failure; day/night and presets where supported; unsupported hardware controls clearly unavailable. |
| Recovery | NVR restart, network change, auth expiry/rate limit, HLS session rollover, source rename/delete, WebRTC no frames despite ICE, queued starts and lifecycle churn. No source refresh or admin mutation occurs automatically. |
| Isolation/load | Four cards run for 30 minutes with bounded queues/buffers; mount/unmount 50 times leaves zero active card-owned peer/WS/HLS/audio resources; one retry/config change cannot interrupt another card; two proxy prefixes retain independent cookies. Record browser measurements rather than promise a universal memory number. |
| Browsers | Chromium/Firefox desktop, Safari on macOS/iOS and HA Companion WebView on available Android/iOS hardware, with exact tested versions. Playwright WebKit is useful coverage but is not proof of Safari/native HLS/Companion microphone support. Untested platforms stay unclaimed. |

## External evidence and remaining blockers

- The user's installed lightNVR version/tag, managed go2rtc build and sidecar routing remain unconfirmed; the isolated tested versions are recorded in docs/verification.md. The user's sample establishes that one remote WebRTC setup partly works; it does not establish discovery, cross-origin MSE, native HLS or all control permissions. Do not infer deployment details or access production solely from that sample.
- Actual upstream protocol/proxy proof in T1/T3 is a go/no-go prerequisite. Source inspection establishes the intended endpoints and limitations, not that a deployed browser topology passes. A JSON OpenAPI file was located, but its full content could not be retrieved through the connector during research; the concrete source/API wrappers and explicit non-JSON media dispositions were inspected instead. T1 must confirm the specific response fixtures it implements.
- Secure context, trusted certificates, microphone grant, camera backchannel compatibility, policy grants and reachable ICE candidates are separate requirements. Trusted HTTPS is necessary for ordinary remote/LAN talk, not sufficient for successful two-way audio. MSE/HLS cannot supply the WebRTC microphone path.
- Same-origin routing may require control of the proxy serving HA, beyond the existing NVR-side sidecar. Remote HA cloud/internal access may have a different origin with no such prefix. The editor must expose this requirement. If the intended topology cannot meet it, implementing an HA integration/server enhancement would be a new scope decision, not a hidden task.
- HACS public repository/default-list acceptance and compatible open-source licensing must be satisfied for marketplace distribution. A prepared release cannot guarantee HACS reviewers' acceptance or timing.
- Physical test camera, speaker/microphone, Safari/Companion devices, isolated lightNVR and a writable Git/execution environment may be unavailable. Record each missing verification and do not claim it passed.

## Official external references checked

- [HA custom card API](https://developers.home-assistant.io/docs/frontend/custom-ui/custom-card/) and [editor/picker API](https://contributors.home-assistant.io/frontend/custom-ui/card-editor/): custom element lifecycle, registration, default config, getConfigElement and complete config-changed events. Avoid relying on newer optional form APIs when a custom discovery editor is needed.
- [HACS Dashboard/plugin requirements](https://hacs.xyz/docs/publish/plugin/), [general requirements](https://hacs.xyz/docs/publish/start/), [default repository inclusion](https://hacs.xyz/docs/publish/include/): public GitHub repository, matching bundle filename, documented installation, release/metadata/license/screenshot requirements and separate reviewed submission. Plugin backend category is `plugin`, UI category is Dashboard.
- [getUserMedia secure-context rules](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia), [WebSocket constructor](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket), [CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS): browser capability and authentication boundaries.
- [hls.js v1.7.4 API](https://raw.githubusercontent.com/video-dev/hls.js/v1.7.4/docs/API.md): loader credentials/hooks, support detection, recovery and destruction. Upstream declares ^1.7.4; T1 pins the actual tested card version rather than assuming that range is an installed version.
- [Traefik StripPrefix](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/stripprefix/): routing prefix support; this does not itself prove cookie or playlist response rewriting. Check the actual chosen proxy versions and official WS/configuration docs when constructing T3.

## Execution status

T1–T10 implementation and local integration verification are complete within the explicitly recorded development scope. Authenticated store installation, device-specific behavior and endurance checks remain external acceptance gates; no corresponding support certification is claimed. See [verification](docs/verification.md) for current actual results and device/store limits, and [handoff](docs/HANDOFF.md) for the operator's next steps. Public release tags and catalog submissions have not been made. Private execution history is retained in the durable run, not published here.
