# Advanced Camera Card and lightNVR

Reviewed Advanced Camera Card **8.2.0** (released 2026-11-09). This is an interoperability investigation, not an installed ACC acceptance result.

Its [live providers](https://github.com/dermotduffy/advanced-camera-card/blob/v8.2.0/docs/configuration/cameras/live-provider.md) differ:

| Provider | Consequence |
| --- | --- |
| `webrtc-card` | Embeds AlexxIT's WebRTC card; changing the outer UI does not replace that player. |
| `go2rtc` | Built-in VideoRTC client, with its own ACC changes; it is not this project's HTTP-SDP client. A different outer card does not establish freedom from playback/reconnect problems. |
| `go2rtc-experimental` | Independent implementation documented as experimental. A useful comparison when investigating player behavior; it still needs authenticated signaling/media access. |
| `ha` | Uses an existing HA camera entity and the WebRTC/HLS support supplied by that entity's integration. This does not automatically create a lightNVR integration. |

## Playback-only trial with the NVR-side gateway

**Authentication prerequisite:** establish the gateway session through the working lightNVR card's Connect/discovery in the same browser first. ACC's URL/stream configuration does not perform lightNVR login or renew that session. Logging into the ordinary NVR UI creates a different root cookie and is insufficient for this scoped gateway. This is a session-dependent experiment, not a self-contained replacement.

```yaml
type: custom:advanced-camera-card
cameras:
  - id: front_door
    title: Front Door
    engine: generic
    live_provider: go2rtc-experimental
    proxy:
      live: false
    go2rtc:
      url: https://nvr.example.test/ha-card/go2rtc
      stream: front_door_sub
      modes:
        - webrtc
```

Use the gateway's actual NVR hostname and existing permitted source. The URL ends at `go2rtc`, without a trailing slash, because ACC appends `/api/ws?src=...`. Explicit `proxy.live: false` selects the direct browser path rather than optional HA web-proxy integration. Basic/URL-embedded credentials are not a substitute for this cookie session.

The owned real-server browser test verifies an authenticated go2rtc WebSocket `webrtc/offer` receives a valid SDP answer through this gateway, in addition to this card's HTTP-SDP, MSE and HLS paths. It does **not** mount ACC or prove its playback, renewal, UI or device behavior. When the cookie expires or is absent, the NVR still denies access; ACC has no lightNVR login dialog to resolve that automatically.

The gateway intentionally blocks raw go2rtc `/api/streams` and other administrative endpoints. ACC's go2rtc metadata builder uses that route for capability detection; do not publish it to make microphone icons appear. ACC 8.2.0's [two-way audio documentation](https://github.com/dermotduffy/advanced-camera-card/blob/v8.2.0/docs/usage/2-way-audio.md) supports Frigate cameras, not a generic lightNVR camera. Neither talk nor lightNVR PTZ/privacy/recording controls are claimed by this trial. A proper lightNVR provider would need explicit login/session handling and permission-aware metadata/control mapping.

## Initial playback errors

A brief failure followed by stable WebRTC does not identify a TURN problem. This card reports browser `video.play()` rejection as `WebRTC video playback failed`; ICE failure/disconnection uses `WebRTC media connection failed` or the ICE grace-period message. The exact failure code/message and connection state are needed to distinguish them. No transport parameters or TURN configuration were changed based only on the screenshot/report.

Successful playback with the same camera/server is evidence to investigate differences in player lifecycle, signaling and reconnect handling. It does not establish the original freeze's root cause or a measured long-duration fix.
