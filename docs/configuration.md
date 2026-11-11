# Configuration

Use `type: custom:lightnvr-camera-card`. The version-1 schema is strict: unknown card options are rejected. Defaults below describe the card, not a grant of server permission. Use an existing lightNVR camera name; do not paste RTSP URLs or camera credentials. The [single](../examples/cards/single.yaml), [panel](../examples/cards/panel.yaml) and [grid](../examples/cards/grid.yaml) examples use only placeholder names and session login.

## Connection and identity

| Key | Default / allowed value | Meaning |
| --- | --- | --- |
| `version` | `1` | Config version. |
| `server` | Required | lightNVR/gateway root, e.g. `https://nvr.example.test/ha-card/` for the NVR-side gateway, or `/lightnvr/front/` for an HA-origin prefix. No URL userinfo, query, fragment or protocol-relative URL. Use a trailing slash. HTTPS dashboard requires secure media routes. |
| `go2rtc_path` | `go2rtc/` | Relative path of slash-terminated alphanumeric/underscore/hyphen segments under the lightNVR root. Never a raw public go2rtc host. |
| `viewer_url` | Unset | Explicit HTTP(S) NVR web UI root for open/timeline links. The scoped API proxy does not serve the full web UI. No userinfo/query/fragment. |
| `username`, `password` | Unset | lightNVR login credentials; never HA credentials. Saved dashboard values are readable by configuration readers. |
| `credential_storage` | `dashboard` or `session` | Session mode uses in-memory credentials; the editor omits username/password when saving. Do not manually leave secrets in YAML and expect this option to erase that YAML. No localStorage credential cache. |
| `auth` | `session` or `basic` | Session cookie is the supported full-media route. Basic is tested for same-origin fetch only; it cannot authenticate browser WS/native video. |
| `stream` | Required nonempty string | Canonical discovered camera name, or literal selector for manual use. Discovery must still succeed. |
| `camera_uuid` | Unset | Optional discovered stable identity. Prefer editor selection. |
| `profile` | `main` or `sub` | Managed camera profile; `sub` requires a verified managed substream. |
| `source` | Unset | Explicit exact source override. `front_door_sub` remains literal; the card never appends `_sub` twice or invents a canonical control target. |
| `title` | Unset | Display label. |

One NVR/user cookie scope shares login/metadata, while each card owns its player and microphone. Two users cannot silently replace each other's session in the same cookie scope; use separately isolated proxy prefixes. Replace credentials only after other holders release the old scope. Login may require interactive TOTP; forced password changes belong in the NVR UI. Forced inline MFA without a challenge is unsupported. Remembered-device cookies are not forwarded by the reference helper.

Missing discovery APIs on older servers currently block playback, including manual sources: an unsupported route cannot safely be distinguished from every misrouted/denied response. No legacy full inventory/go2rtc administrative discovery is attempted. Unknown capability fields are shown as unverified and the server authorizes each request.

## Transport and recovery

| Key | Default / validation | Meaning |
| --- | --- | --- |
| `transports` | `[webrtc, mse, hls]` | Ordered unique list, 1–3 entries. One entry forces a renderer. Browser/server exclusions can remove unavailable choices. |
| `hls.provider` | `auto`, `go2rtc`, `native` | Auto honors server force-native/go2rtc availability. A failed go2rtc HLS request does not select native as a recovery bypass. |
| `timeouts.connection_ms` | `30000` or `inherit` | Setup/first decoded frame deadline; inherit uses the server value when available. |
| `timeouts.ice_grace_ms` | `5000` | ICE recovery grace. |
| `timeouts.webrtc_ms`, `.mse_ms`, `.hls_ms` | Unset | Per-renderer deadline overrides. |
| `retry.base_ms`, `.cap_ms` | `2000`, `30000` | Exponential retry bounds; cap must be at least base. |
| `retry.attempts` | `5`, integer 0–100 | Bounded automatic retry budget. |
| `retry.jitter` | `0.2`, range 0–1 | Retry jitter fraction. |
| `ice_servers` | Unset, max 16 entries | Explicit ICE override; entries have `urls` (STUN/TURN URL or nonempty URL list), optional `username` and `credential`. Treat TURN secrets as dashboard credentials. Otherwise server ICE configuration is used. |

All numeric duration fields are integer milliseconds from 100 to 300000. `forceNativeHls` changes the HLS provider only; it does not disable enabled WebRTC/MSE. Native HLS requires a discovered canonical exact **main** source and permitted receive listening: it cannot safely implement a selected substream or audio-track exclusion. Bundled hls.js is preferred when supported; browser native playback is used only when hls.js is unavailable and native support exists. Native/WS failures that could hide policy denials are terminal.

Auth/MFA, 403, privacy and configuration failures stop retry/fallback. Offline/rate-limit failures back off on the same renderer; other eligible transport failures can advance through the configured order. **Play / retry locally** retries only this card; it never refreshes a camera source. MSE/HLS may have more latency and cannot carry the microphone. A frame must decode before the card reports playing.

## Audio, controls and layout

| Key | Default / allowed value | Meaning |
| --- | --- | --- |
| `video.enabled` | `true` only | Audio-only cards are unsupported. |
| `audio.enabled` | `true` | With `false`, also set `listen: false` and `microphone: false`. |
| `audio.listen` | `true` | Permit requesting receive audio, subject to server policy. |
| `audio.muted` | `true` | Initial local speaker mute. Autoplay rules may still require a gesture. |
| `audio.microphone` | `false` | Offer permitted WebRTC talk; requires WebRTC in the transport list. It never starts capture on mount. |
| `audio.talk_mode` | `ptt` or `toggle` | Hold/release by default; toggle requires a second gesture to stop. |
| `audio.volume` | `1`, range 0–1 | Local speaker volume. |
| `controls` | Empty object | Optional booleans listed below. Visibility does not override server authorization. |
| `layout.aspect_ratio` | `1.7777777777777777`, positive | Video width/height. |
| `layout.object_fit` | `contain` or `cover` | Fit/letterbox or crop. |
| `layout.fullscreen_main` | `false` | Temporarily use discovered main in fullscreen, restore selected sub on exit where safe. Exact manual sources stay exact. |
| `playback_visibility.hidden` | `pause` or `continue` | Playback policy when the document is hidden. |
| `playback_visibility.offscreen` | `pause` or `continue` | Playback policy when the card leaves the viewport. |

Control flags: `speaker`, `microphone`, `fullscreen`, `snapshot`, `transport`, `profile`, `zoom`, `ptz`, `daynight`, `recording`, `privacy`, `detection`, `refresh_source`, `timeline`. Unset flags use the UI defaults and capability gates; source refresh is off by default. Speaker changes are local and independent of talk. Local digital zoom/pan does not command the camera. PTZ hardware, presets, day/night and other mutations require canonical camera identity, support and server permission. Stop/release is attempted on interaction exit, but a browser cannot guarantee a motor stops during a network failure. Recording/privacy/source changes affect shared NVR state and require explicit confirmation. Detection display is read-only; camera-specific dewarping and management remain in the NVR UI.

Hidden/offscreen cards always stop talk and PTZ interaction even when playback policy is `continue`. Talk also stops on release/cancel/blur, disconnect, fallback, reconfigure and removal; it never automatically resumes.

## Native HA metadata is separate

`visibility` is HA's **condition array**, not playback policy. The card preserves `grid_options`, `view_layout`, legacy `layout_options`, `index`, `view_index`, `disabled` and native `visibility`. HA evaluates the conditions. Metadata-only resize/placement updates are excluded from media identity so they do not restart authentication, playback or talk.

`grid_options` accepts numeric or `full` columns, numeric or `auto` rows, and numeric min/max columns/rows, with no artificial 12-column cap. `view_layout` is retained for layout hosts. HA can migrate legacy `layout_options` to `grid_options`. The old pre-release object spelling `visibility: {hidden: pause, offscreen: pause}` normalizes to `playback_visibility` only when the new key is absent; do not specify both. New YAML must use `playback_visibility` for media policy.

## Exact legacy migration

The visual editor's import is a **preview**; review before saving. Only the supported legacy fields below are accepted; unknown options fail explicitly.

| Legacy `custom:webrtc-camera` option | Version-1 result |
| --- | --- |
| `type` (optional in import) | `custom:lightnvr-camera-card` |
| `server: https://USER:PASS@nvr.example.test/go2rtc/` | `server: https://nvr.example.test/`, decoded `username: USER`, `password: PASS`, default `go2rtc_path: go2rtc/`. Userinfo is removed from outgoing URLs. A proxy prefix before `/go2rtc/` is retained. |
| `url: front_door_sub` | Both `stream: front_door_sub` and `source: front_door_sub`; default `profile: main`. This is an exact source, not an inferred sub profile of `front_door`. |
| `mode: webrtc` / `mse` / `hls` | `transports: [webrtc]` / `[mse]` / `[hls]`. Absent mode keeps default ordered fallback. |
| `media: video,audio,microphone` | `audio.listen: true`, `audio.muted: false`, `audio.microphone: true`; video remains enabled. Tokens may also be supplied in a `media` object. |
| `media: video` | `audio.listen: false`, `audio.muted: true`, `audio.microphone: false`. |
| Missing `media` | Listen true, muted true, microphone false. For an object, omitted `audio` defaults to listening true but muted; omitted microphone defaults false. |
| `ui: false` | All supported control flags false. `ui: true` or absent retains defaults. |
| HA layout/condition fields | Preserved using the native metadata fields above. |

The example URL is a placeholder, never a real credential. Audio-only import is rejected. Microphone with a forced non-WebRTC mode is rejected by the new schema. Manual sources do not invent a camera identity for mutations/native HLS. Legacy options from other cards are not silently copied. Saved credentials require review; prefer session storage and a supported scoped gateway after import.
