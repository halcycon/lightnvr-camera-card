# API integration (T2)

Import `createNvrClient(config)` from `src/api/index.ts`. A factory from
`createClientFactory(runtime)` gives an isolated registry and optional fetch,
document URL, clock, request deadline and metadata TTL for tests. The production
module registry shares authentication and completed metadata only. It owns no
video element, player, peer connection, WebSocket or microphone.

Call `connect(credentials?, {signal})`, handle the discriminated login result,
then `discover({signal})` and `selectSource(config, inventory)`. A session-only
editor supplies credentials in memory. `completeTotp(challenge, code)` supports
the upstream optional challenge flow. A forced inline-MFA deployment, which
returns a generic 401 before issuing a challenge, is not supported by the frozen
Credentials/LoginResult interface; do not retry it as a network failure. Password
changes require the upstream UI. Redirects returned by login are never followed.

Supported routes use separately cookie-scoped prefixes: either a same-origin
prefix, or an NVR-side gateway for same-site HTTPS dashboard origins. The latter
exposes an exact HTTPS capability marker after enforcing its Origin allowlist;
the client retains the factual cross-origin profile and enables cookie media
only after observing that marker. Authentication/permissions remain separate.
Session login checks an existing cookie's identity before replacing a session.
A configured username is enforced even without a configured password. Conflicts
block the scope until every holder disposes it; a new scope still verifies any
remaining browser cookie. Changing passwords cancels older requests and clears
metadata. Password replacement while multiple clients reference the scope is
rejected; dispose the previous holders before connecting the replacement.
Basic mode uses UTF-8 bytes, an Authorization header and `credentials: omit` on
same-origin fetch routes only. It does not create a browser cookie and cannot
authenticate a native video element or a browser WebSocket. It therefore does not
promise MSE/native HLS or WebSocket signaling support. No credentials go in URLs.

Discovery requests only the authorized live summary surface, walks every page
(up to 10,000), and rejects changing page counts, duplicate camera names and
malformed responses. Empty inventory is successful. Completed inventory/config
are frozen, scoped by connection identity, cached for 30 seconds by default
(maximum 60 seconds), and dropped with the last reference. Requests and response
bodies have a 10-second deadline (maximum configurable deadline 60 seconds).
Each caller owns its signal; cancelling a login waiter does not interrupt another
card's login. Call `dispose()` on teardown; it is repeat-safe. A 401 can trigger
one shared reauthentication and one GET replay. Writes are never replayed. A 403
is terminal. Rate limits carry bounded safe retry delays; there is no automatic
retry loop or automatic source refresh.

Hardware availability is separate from permission. Missing grants remain
`unknown`; inventory membership establishes live-view visibility, while a false
hardware flag can establish lack of support. The live summary exposes an actual
privacy-control flag but no general action-grant list. The server authorizes
every request. Capitalized upstream statuses are normalized; Error/Stopped map
to offline, Running to online, transitional/degraded/unrecognized states remain
unknown. Upstream `*_only` and `*_then_*` playback policies provide only a preferred
first renderer in the frozen summary, never an imposed fallback sequence. `auto`
provides no hint. The card's configured transports remain authoritative.

`selectSource` keeps canonical camera names/UUIDs separate from exact source
names. A literal `front_door_sub` camera remains profile main; a sub profile of
`front_door` retains that canonical camera identity. A manual exact source without
a matching canonical selector has no camera controls or native playlist.
`mediaUrls` omits native HLS for sub profiles and different manual sources: the
verified native route selects a canonical camera and cannot explicitly request
those profiles. It must not substitute main video for a selected sub source.
Native HLS is also omitted when listen=false: that route has no per-request
track selector. Go2rtc HLS uses `mp4=flac` and a sole `video=` selector when
listening is disabled. An empty `audio=` selector means any audio, not disabled
audio, in the [pinned fork's parser](https://github.com/opensensor/go2rtc/blob/9ca672a5d25f3bfca805cebcb835b7433d65e64f/pkg/core/media.go#L169).
WebRTC, MSE and snapshot URLs contain only the source selector; T4 must enforce
listen/talk independently through SDP and WebSocket media negotiation.

`authorizedFetch` accepts relative media routes under the normalized base,
including documented go2rtc HLS children and native HLS files. Adapters strip the
base from an in-scope absolute media URL before using it. Traversal, redirects,
foreign routes and go2rtc administration/discovery routes are rejected. Responses
must be consumed or cancelled by the caller. Media errors can be non-JSON. Only
4 KiB of a go2rtc server-error body is inspected internally for known connectivity
failures; resulting source-offline messages are fixed, and no raw text is logged.
`safeDiagnostic` returns an allowlist of fixed message, code, status and retry
delay. Never serialize a client, credentials, ICE credentials or raw wire data.

Controls use canonical camera names and the verified lightNVR routes. PTZ axes
x/y/z map to pan/tilt/zoom. The frozen optional PTZ speed has no upstream wire
field and is rejected explicitly. Recording start and source refresh return
`accepted` for HTTP 202, requiring a later state read. Controls validate the
success flag and never expose raw response fields. Detection reads select only
geometry, label and confidence. Controls do not add confirmation UI: T7 owns
user gestures, confirmations, PTZ stop/release and permission presentation.

Unit fixtures use generated data and mocked fetch. They do not prove a real
restricted viewer matrix, actual MFA/lockout/rate-limit deployments, physical
camera control/talk, or additional browser/server compatibility. T1's independent
real-server connectivity receipt remains the protocol baseline; T10 must retain
its stated acceptance boundaries.
