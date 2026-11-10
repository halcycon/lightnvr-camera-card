# Card/viewer integration (T7)

`src/index.ts` registers `lightnvr-camera-card` and its `window.customCards` picker
entry once. `LightNvrCameraCard` is a Lit custom element using HA theme variables,
responsive wrapping controls and native keyboard/focus semantics. It exposes
`setConfig`, a deliberately inert `hass` setter, masonry sizing and auto-height
Sections grid defaults. Panel, native grid and stack composition use the host
card's own sizing; actual HA/browser acceptance remains T10. Static editor/stub
helpers import the verified T8 exports lazily. No other custom card tag is used.

One `ViewerSession` owns a typed API client reference and the verified T6
controller, T4 talk controller and T4/T5 adapters. Reconfiguration immediately
invalidates the previous lifetime; replacement waits for disposal. Repeated
identical configs, HA metadata-only changes and HA state updates do not recreate media.
The full received config is retained separately from local profile/volume choices;
`stripHaMetadata` compares media identity without layout or HA condition metadata.
Resize updates preserve active talk and pending login, and carry current metadata
through fullscreen profile restoration. HA owns actual condition evaluation;
visibility loss/removal still stops interactions through the normal lifecycle. Removal releases
listeners, intersection observation, detection timers/readers, download URLs,
API references and playback resources. Inline session credentials/TOTP use the
API client; no persistence, copied authentication, raw media player or network
fallback is added to the UI. Superseded login results cannot overwrite a later
challenge. No microphone is acquired until a deliberate permitted gesture.

Unknown grants are labelled unverified and explicit typed requests let the
server authorize them; known denial wins. Manual sources require a discovered
canonical camera selector for camera mutations. Listening only toggles local
speaker output; it never stops or renegotiates talk. Microphone controls require
secure HA context, trusted HTTPS/WSS target, confirmed backchannel and playing
WebRTC. Secure same-origin HTTP loopback development is the narrow localhost,
127.0.0.1 or ::1 exception. Certificate trust, document/browser grants, negotiated
sender and actual camera compatibility remain independent runtime requirements.

PTT uses pointer capture plus window release, keyboard Space/Enter without
repeat, cancellation, lost capture, blur and Escape. Toggle talk persists only
until another gesture or interaction exit. Hidden/offscreen state, transport
change, reconfiguration and removal stop talk/PTZ even with continuing video.
Document visibility and intersection are distinct so each playback visibility
policy remains effective. Active mic and optional local meter are observable.

Motorized PTZ is separate from local digital zoom/pan. Speed scales x/y/z locally;
no unsupported wire speed field is sent. Home/preset movements also retain a stop
path. Release sends an immediate stop and a second stop after a pending motion
acknowledges. Disposal keeps that API reference usable for up to two seconds of
PTZ cleanup. A server/network operation exceeding that bound, or a rejected stop,
cannot guarantee physical motor shutdown; no browser-only implementation proves
that. Cleanup never logs or issues source-refresh recovery. Another card/client
is never disposed by this card's controller.

Day/night, recording, privacy, refresh, preset-save and set-home require a native
per-action confirmation explaining impact on other viewers. Recording/privacy
read current state before toggling. A 202 remains 'accepted', with a subsequent
state read rather than optimistic 'running'. Privacy changes stop local media
and detections even on ambiguous completion; resumption is an explicit local
retry. Source refresh is off by default and only runs on its own confirmed click.
Fullscreen may temporarily select discovered main and restore sub once on failed
or offline upgrade/exit, without restoring around auth, denial or privacy; explicit manual source names are preserved. Fisheye/ePTZ is shown
as unavailable because the frozen viewer contract supplies no such operation.

Snapshots use authorizedFetch for the typed frame URL; bodies are bounded to
16 MiB, 4096 chunks and 10 seconds. Canvas fallback requires positive snapshot
permission, no known privacy and an explicit missing-API 404/405/501, never
401/403, network or malformed-success fallback. Browser origin-clean and decoded
frame requirements remain authoritative. Privacy learned during a pending request
also blocks stale pixels. Generated download names contain no URLs/credentials.
Detection polling is read-only, at most once per second without overlap, bounded
to 100 boxes, stopped on hidden/offscreen/nonplaying/removal and cancelled on
privacy. Normalized boxes follow the video's contain/cover geometry and local
transform; server text is escaped by Lit. No zone/detection configuration is added.

Links require explicit `viewer_url` as the lightNVR web UI root; an API proxy is
never treated as a web UI. A discovered canonical camera links to relative
`timeline.html?stream=<encoded canonical name>&date=YYYY-MM-DD&time=HH:mm:ss`,
using local date/time at the click and preserving web-root subpaths. Fullscreen
adds `fullscreen=1&nav=fine`. This route is confirmed in pinned upstream
`recordings/formatUtils.ts` and the WebRTC viewer call site. Sources without a
known canonical camera retain a root-only “Open lightNVR” link; raw manual source
values/RTSP URLs are never placed in the timeline query. The shared config preserves HA metadata and keeps unrelated application fields strict.

Validation uses happy-dom, generated data, typed fakes and an actual T6/T4
controller/talk integration with a simulated adapter. It proves UI decisions,
state isolation and cancellation, not real lightNVR compatibility, rendered
browser media, physical PTZ/audio, trusted microphone UX, HA layouts or HACS.
Those human/browser/device checks remain T10. Implementation is independently
written from contracts, documented protocol and official HA custom-card API.

Sections/layout metadata compatibility is resolved in code with the coordinator's
shared schema/editor/controller changes and T7's media-identity boundary. See
[the compatibility notes](ha-layout-compatibility.md) and the focused acceptance,
preservation and no-restart tests. Actual HA browser resize/reload and condition
visibility acceptance remain T10 work; default grid sizing alone is not proof.

Playback visibility policy is `playback_visibility: {hidden, offscreen}`. The
separate optional `visibility` array is native HA conditions. Legacy object
`visibility` is normalized only when `playback_visibility` is absent; specifying
both an old object and the new policy is rejected as ambiguous.
