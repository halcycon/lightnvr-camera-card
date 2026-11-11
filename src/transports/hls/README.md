# HLS adapter (T5)

`createHlsAdapter(options?)` implements the frozen `TransportAdapter`. `options.hls`
can inject the pinned hls.js constructor for tests. Production imports bundled
hls.js 1.7.4; it loads no remote scripts and creates no worker. This implementation
was independently written from protocol/API documentation; no upstream component
implementation was copied.

Provider selection happens once before requesting media. `auto` honors server
force-native/global go2rtc availability; explicit go2rtc conflicts with forced
native/disabled go2rtc are rejected. An enabled go2rtc request failure never
switches to native. Native provider needs `mediaUrls.nativeHls`: canonical main
source and permitted configured listening. Substreams, unrelated manual sources,
and listen=false cannot use that route. Default local mute does not exclude
native HLS because listening permission and output mute are separate.

Playback engine selection is separate from the server provider and happens before
any media request. Bundled hls.js is preferred whenever `Hls.isSupported()` is true,
even when native `canPlayType` returns `maybe` or `probably`. This follows the
[pinned official hls.js 1.7.4 example](https://github.com/video-dev/hls.js/blob/v1.7.4/README.md#embedding-hlsjs):
a nonempty native capability result does not guarantee an asset will decode.
Native browser playback is used only when bundled hls.js is unsupported, native
`canPlayType` supports HLS, and the client uses a non-root, cookie-scoped proxy
that is same-origin or explicitly advertises the HTTPS NVR-side gateway capability.
Neither engine available means `unsupported-api` before
requests. No engine switch follows a native failure. That proxy must
implement the verified recipe in `docs/connectivity.md`: it confines playlists,
children and redirects and preserves credential binding. A pathname alone cannot
prove an operator deployed that recipe. This adapter cannot attach headers to
native video, inspect its child requests, or validate an arbitrary proxy. Basic,
unverified cross-origin and unscoped roots use hls.js where available. Native
Safari/Companion playback through the NVR-side gateway is not established.

**Deliberate limitation:** native video hides HTTP status. Every native `error`,
including apparent network/decode failures, errors without a MediaError,
and non-autoplay `play()` rejections,
is therefore a terminal `policy` failure. It could represent 401/403 or revoked
authority. Like an opaque MSE WebSocket close/error, it must not trigger automatic
retry/fallback around a denial. Genuine native network/codec failures consequently
require an explicit user retry after resolving the cause. The adapter does not
claim it observed a particular HTTP status. Authenticated hls.js loads retain
actual typed API/status failures. No error uses raw URLs, upstream text or headers.

All hls.js loads (manifest, child playlist, init, segment, key, alternate track)
use `authorizedFetch` after stripping the normalized base. URI validation rejects
foreign origins, userinfo, out-of-prefix paths, traversal, unscoped routes and
unsupported variable URLs. Existing query bytes/session IDs are preserved;
credentials are never added to URLs. Redirects are rejected, not followed.
Only a validated byte Range is forwarded from loader context headers; the client
owns authentication. The pinned fragment loader initializes non-range requests
with `rangeStart=0, rangeEnd=0`; this full-resource sentinel sends no Range header,
matching its [official loader](https://github.com/video-dev/hls.js/blob/v1.7.4/src/utils/fetch-loader.ts).
Other invalid/equal/reversed byte ranges are rejected. Bodies are bounded to 1 MiB text/16 MiB binary and 4096
chunks, with a maximum 30-second loader deadline. Aborts cancel readers and late
responses. Text playlists are validated before hls.js receives them.

hls.js uses 4-second target/8-second maximum buffers, no back buffer, and an
8 MiB buffer budget. There are no request retries or provider changes inside the
adapter. One media-error recovery is allowed per start; subsequent fatal errors
terminate. The playback controller owns backoff. First-frame uses a video frame
callback (or advancing decoded time when unavailable); a manifest isn't playing.
Autoplay denial cancels the deadline and leaves the current player for the
controller's explicit play gesture. Stop/restart/abort destroy the engine,
loaders/readers, frame callback, listeners, timers, and video source. Neither
fallback transport exposes an audio sender or acquires microphone media.

Verification: `npm run test:unit -- tests/unit/mse tests/unit/hls`,
`npm run typecheck`, and scoped ESLint. `node tests/unit/hls/browser-smoke.mjs`
bundles into a unique `/tmp/lightnvr-T5-browser-*` directory, serves only owned
local H.264/AAC fixtures through a synthetic isolated cookie/WS/HLS service,
and checks Chromium decoded video/audio, unmute and teardown for both adapters.
It closes the browser/service/sockets and removes that temporary bundle, including
on failure. This proves generated-media rendering, not real lightNVR protocol,
physical speaker output, native Safari, ManagedMediaSource device support, HA,
or production acceptance. T1/T3 receipts remain the upstream protocol baseline;
T10 owns browser/device/upstream integration acceptance.
