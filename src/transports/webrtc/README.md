# WebRTC adapter (T4)

`createWebRtcAdapter(options?)` implements the frozen `TransportAdapter` interface.
It uses the existing `NvrClient` for server ICE and authenticated HTTP SDP. Exact
source selection is preserved by `mediaUrls`; the normalized NVR base is stripped
before `authorizedFetch`. No credential handling, native-media headers, public
STUN defaults, trickle HTTP API, hidden talk connection or source mutation exists
here. An explicit `ice_servers` list, including `[]`, overrides server settings;
a failed server ICE read is reported rather than replaced with another service.

Video is recvonly. Audio enabled, server audio policy, configured listen,
microphone intent, backchannel support and separate action denials determine
omitted/recvonly/sendonly/sendrecv audio. Muted is the initial local speaker
setting, independent of configured listen permission and the microphone sender.
Unknown grants remain unknown and subject to the server's SDP authorization;
explicit denials always win. The sender is exposed only after a negotiated
send direction. Merely exposing it never captures audio.

`setListening(enabled)` is a local speaker gesture, matching the MSE/HLS
adapters: enabling without negotiated listen permission rejects with `policy`;
otherwise it sets `video.muted = !enabled` and enabling calls `play()`. It never
renegotiates or stops talk. A config change needs a new adapter start. Initial
muted autoplay remains the default until a user speaker action.

The gathered local description is POSTed once as application/sdp after complete
ICE or the bounded gathering interval (default 1000 ms). Candidates gathered at
the bound are included; there is no later candidate channel. Only 200/201 SDP
answers are accepted. Body reading is abortable and capped at 2 MiB. The total
connection deadline covers ICE configuration, SDP headers/body, browser setup and
first decoded video. ICE success, metadata and incoming bytes alone never mean
playing. Rendered frame callbacks, or decoded current video on playing/timeupdate
and numeric decoding stats, establish first frame. Only supported codec entries
are reordered, retaining browser fallback/repair codecs.

Setup failures emit `failure` and reject `start` with `NvrError`; failures after
setup emit only. Explicit abort/supersession rejects as cancelled without a
failure event. Stop is repeat-safe and synchronously revokes sender leases,
closes the peer, stops remote tracks, removes callbacks/listeners and timers,
and clears the owned video stream. It cannot clear a replacement stream. ICE
disconnect stops talk immediately and starts grace; recovery renews the sender
lease without acquiring a microphone. Persistent disconnect and failed ICE
close the session. Video track end is source-offline; audio track end removes
only that audio track. No adapter retry or transport fallback occurs internally.

Autoplay denial emits `autoplay`, cancels the first-frame deadline and retains
the peer for a user play gesture through `setListening`. T6 must retain that
adapter and suspend fallback/retry. A local speaker gesture cannot enable a
receive direction excluded by config/policy; a video-only user play action can
call the retained video element's `play()` directly. TLS/network errors display
only HA document and NVR signaling origins for contextual diagnosis, never
source queries, SDP, credentials, paths or raw upstream errors. Browser fetch
cannot reliably distinguish TLS trust, CORS and network failure, so the message
names those checks without falsely identifying a specific certificate failure.

Options inject peer/stream factories, capabilities, gathering/stat intervals,
document URL and an optional numeric stats observer. Stats expose only video
frames/bytes/packet loss and nominated-pair RTT, never candidate addresses.

Unit tests are controlled browser API simulations. They do not establish real
rendering, audible listen/talk, production topology, hardware/browser support or
HA/HACS installation. T1/T3 receipts establish actual SDP/proxy protocol evidence;
T10 separately verifies decoded media and camera talk. This implementation is
independently written; no upstream implementation code was copied.
