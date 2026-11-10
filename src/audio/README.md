# Talk lifecycle (T4)

`createTalkController(options?)` implements the frozen `TalkController` interface.
Construction, reads, subscriptions, playback and ICE recovery never acquire a
microphone. T7/T6 must call `start(sender, gestureSignal)` only from an explicit
PTT/toggle gesture, using `getAudioSender()` from the current WebRTC adapter.
Abort that gesture or call `stop()` on release/cancel, blur, visibility loss,
transport/config change and removal. Keyboard repeat and pointer capture belong
to T7. PTT and toggle share this lifecycle; neither mode owns a background mic.

`start` emits pending immediately. Only a successful current sender attachment
emits active. Permission results, sender operations, meter updates and errors are
bound to their original request. `stop` invalidates that request, disables/stops
all returned tracks and stops the meter synchronously; its promise waits for
serialized sender detachment. A late permission result is stopped without ever
attaching. A release during attachment queues detachment before a newer attach
on that sender. Replacement peers cannot receive an old request. Adapter leases
also invalidate capture on disconnect/close; ICE recovery permits a fresh gesture
without resuming capture. There is no automatic microphone retry.

Snapshots and nested failures are frozen. Subscriptions receive the initial
snapshot and pending/active/failure/optional RMS level changes; unsubscribe on
teardown. The built-in meter uses a local analyser with no output connection,
and closes its AudioContext on stop. Meter support is optional. Dispose is
repeat-safe and prevents further starts.

Failures reject `start` with `NvrError` and appear in state: insecure document
context is `configuration`, denied browser/document permission is `policy`,
missing capture API/device/audio track is `unsupported-api`, and capture/sender
failure is `ice`. Cancellation/supersession settles quietly and cannot overwrite
a newer error or stream. Raw device errors are never published. The default
capture requests audio processing and never video; every returned track is owned
and stopped. Injected capture/context/meter functions support isolated tests.

Unit tests use generated tracks/streams and controlled asynchronous senders.
They establish lifecycle behavior, not actual microphone permission UX, decoded
media, camera compatibility or audible backchannel reception. T10 owns those
checks. Code is independently written from protocol and lifecycle requirements;
no upstream implementation was copied.
