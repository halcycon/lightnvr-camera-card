# Playback orchestration (T6)

`createPlaybackController({ client, createTransport, talk })` creates one card's
controller. Supply the verified adapter factory and a separate TalkController for
each card. The factory must return a new adapter for each attempt; video elements,
peers, sockets, HLS engines and microphones are never shared. The card creates and
owns its API client reference. T2 refcounts the API session/cache underneath those
references. Controller stop/dispose deliberately never calls `client.dispose()`;
the card releases its reference after controller disposal. Sharing the very same
client object is also safe from controller-initiated disposal.

Call `start(video, validatedConfig, lifetimeSignal?)`. Completion means setup has
settled, not that media has decoded: use the immutable subscribed snapshot for
queued/connecting/playing and error states. Repeating start with the same video
and serialized configuration is a no-op. Home Assistant `hass` updates should
only render the snapshot. A new config or explicit non-autoplay retry cancels the
old generation. Old events and setup completions cannot update a new generation.

The validated transport array is authoritative, default WebRTC → MSE → HLS; a
single entry is fixed mode. Known browser API, server transport and MSE topology
exclusions are filtered before starting an adapter. Server `forceNativeHls` only
selects the HLS provider and does not disable enabled go2rtc WebRTC/MSE. Globally
disabled go2rtc excludes those two transports. Adapter-specific codec exclusions
can still be discovered at setup. Unknown support is attempted, never assumed
permitted. Camera privacy/live-view denial stops before media setup.

Per-cookie-scope FIFO admission permits two concurrent starts by default. A slot
covers connection/metadata/setup through the first decoded frame and is released
on failure, cancellation, or autoplay suspension. Each queue wait is bounded to
30 seconds. Queue timeout enters the same bounded retry budget as other timeouts;
it does not create an adapter. Separate scopes do not block each other. Healthy
players consume no startup slots. Cancellation removes only that card's waiter.

401/auth/MFA/password-change require user authentication. Policy/403/privacy and
configuration failures stop automatic retries/fallback. Opaque WS/native-media
policy failures retain the verified adapters' conservative terminal handling.
Source-offline and rate-limit stay on the same renderer with capped exponential
backoff, configured jitter and a bounded retry count; Retry-After is respected
within a five-minute ceiling. Other transport failures try the next configured
available renderer, then bounded retry rounds. A decoded frame resets the retry
budget. Metadata and first-frame deadlines are bounded; `inherit` uses the server
timeout when available. There is no automatic source refresh or control mutation.

Explicit `source` values work after successful discovery, including an empty
inventory. Without a matching camera selector, identity/capabilities remain
unknown and no canonical camera control/native-HLS route is invented. Discovery
must currently succeed even with an explicit source: the frozen API reports JSON
missing-route 404/405 and HTML proxy 404/405 alike as `unsupported-api` with that
status, losing MIME/body provenance. That cannot safely establish a genuinely
unsupported inventory endpoint. The controller deliberately does not bypass any
discovery failure, including auth/policy/privacy, HTML, CORS/network or malformed
responses. No legacy discovery/fallback route is invented. Manual playback on
older servers without this summary endpoint remains unverified and blocked until
a separately verified API distinction/compatibility contract is available.

An autoplay failure suspends and retains media without network retry. Explicit
`retry()` calls the video element's `play()` within the gesture, preserves mute,
and restores a deadline for a decoded frame. Repeated NotAllowedError remains
suspended. Already decoded retained media can resume without another connection.
Overlapping play gestures cannot apply an older rejected play over a newer one.
Speaker actions are local mute/unmute, bounded by configured listen and policy;
they do not renegotiate or stop talk. The speaker choice survives fallback and
visibility suspension. An explicit config resets it, honoring disabled listening
and default mute. Microphone capture only follows an explicit `startTalk(signal)`
on a permitted, playing WebRTC sender; the caller retains gesture cancellation.

`setVisible` describes intersection/offscreen visibility; document visibility is
observed separately. Each honors its own pause/continue config. Both hide paths
stop talk even when playback continues. Pausing cancels queued/active resources;
showing starts a new generation without resuming the microphone. Teardown calls
talk.stop synchronously, aborts the attempt and closes the adapter before awaiting
serialized sender detachment. Parallel cleanup waits are capped at one second;
dispose separately bounds talk.dispose to one second. This prevents a browser
operation that never settles from blocking fallback/removal. Verified adapters
must still synchronously revoke/close their owned resources on abort/stop; the
controller cannot forcibly settle arbitrary browser promises. Disposal is
idempotent, removes the document observer and talk subscription, clears startup,
deadline and backoff timers, and invalidates late events.

Tests use fake clocks, generated media objects and isolated mock API responses.
They establish state/cancellation/resource behavior, including ten-card FIFO
admission and serialized delayed sender teardown; they do not prove decoded
upstream media, physical camera talk, Safari/Companion or HA/HACS compatibility.
Those remain T10 integration evidence, subject to the T1/T3 receipt boundaries.
