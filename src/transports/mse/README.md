# MSE adapter (T5)

`createMseAdapter(options?)` implements receive-only MSE/ManagedMediaSource.
Options inject a source constructor, WebSocket factory and object-URL functions
for tests. Production uses platform APIs. `lifecycle.ts` also supplies the owned
receive-only lifecycle to HLS. Code is independently written from the pinned
protocol and hls.js API, rather than copied from upstream components.

Same-origin cookie auth is required. Basic cannot authenticate a browser
WebSocket, and the verified server rejects a foreign browser Origin. No fake
headers or credentials are added to WebSocket URLs. Negotiation waits for both
socket and MediaSource to open, sends once, and advertises supported video codecs
plus audio only when config/server/listen rights permit it. Muting remains local.
Returned MIME codecs must belong to offered codec families and pass the browser's
full MIME support check; lower H.264 profiles remain valid. Binary data before
negotiation, unexpected metadata and malformed/unsupported codecs fail safely.

Queued plus in-flight binary data is bounded to 4 MiB/128 queued chunks.
Appends are serialized. After append, old media is removed to retain ten seconds
and lagging playback moves toward live. Quota recovery evicts to two seconds and
retries the pending append once. No eviction space, repeated quota, append/decode
errors, and queue overflow terminate instead of dropping initialization/media
silently. Buffers and object URLs are removed/revoked on teardown, and late
callbacks/events cannot affect a replacement start. ManagedMediaSource uses
srcObject with remote playback disabled; its real-device compatibility is a T10
boundary.

WebSocket upgrade errors and closures hide the HTTP status. They are deliberately
terminal `policy` failures because they may mean origin/auth/lease denial. This
conservative choice can also stop genuine network interruptions until explicit
retry; no claim of observing a 401/403 is made. There is no adapter reconnect loop.
First-frame deadlines, autoplay suspension and deterministic cleanup share the
lifecycle described in `../hls/README.md`.
