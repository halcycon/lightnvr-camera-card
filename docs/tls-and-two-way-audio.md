# TLS, listening and two-way audio

**Two-way audio requires Home Assistant to be opened in a secure context (normally trusted HTTPS), microphone permission, HTTPS/WSS media signaling for the HTTPS dashboard, and a compatible camera with lightNVR backchannel enabled and talk permission. A Traefik TLS sidecar can provide HTTPS to the NVR; it does not by itself secure the HA document or solve cross-origin MSE.**

The document requesting the microphone is Home Assistant. A trusted certificate on the NVR alone does not make an HTTP HA tab secure. Ordinary arbitrary HTTP LAN addresses do not qualify. Browsers have a narrow potentially trustworthy loopback exception (`localhost`, `127.0.0.1`, `::1`); the card permits same-origin HTTP loopback development, not general HTTP LAN talk. Do not use browser security-disabling flags as deployment instructions. See [getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia) and [secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts).

## Route the active HA origin

For same-site HTTPS HA/NVR hostnames, follow the [NVR-side gateway recipe](nvr-side-gateway.md), forwarding a scoped prefix on the NVR hostname to lightNVR's authenticated HTTP gateway. It explicitly validates allowed HA Origins and handles credentialed preflights, cookies, HLS child paths and WS upgrades. StripPrefix or adding CORS headers alone does not provide that behavior. Never expose raw go2rtc or inject a shared administrator login. The ordinary NVR root still rejects cross-origin MSE WS by Origin/Host authority, independently of CORS.

Use trusted HTTPS names for internal and external access, preferably split DNS. With the NVR-side gateway, allow each exact HA hostname/port in `clientOrigins`; the NVR hostname keeps its own scoped cookie. HA URLs on an unrelated site cannot rely on this SameSite=Lax route. With the optional [HA-origin topology](connectivity.md), each active HA origin instead needs the routed prefix and its matching helper origin; a relative `server` follows that active origin. Trust certificates on all intended desktop/mobile devices. Companion runtime behavior still requires device acceptance.

For current HA, manage HTTP/reverse-proxy settings under **Settings → System → Network** and confirm changes after restart within the displayed rollback window. Since HA 2026.8, the old `http:` YAML is imported once and later edits are ignored after migration; remove it after checking imported settings. Trust only the actual HA-facing proxy addresses for forwarded headers. See the [official HTTP configuration/migration instructions](https://www.home-assistant.io/integrations/http/). The card does not configure HA, deploy a proxy or alter the NVR.

## Listening is independent of microphone

Muted autoplay is the default. A browser may require a user gesture for audible media; use **Listen** and, when shown, **Play / retry locally**. OS/device output, codec support and `audio.listen` rights must also permit audio. Speaker mute does not stop an independently permitted active microphone. To disable receive tracks use `audio.listen: false`; local mute is not track exclusion. Native HLS cannot provide that per-request exclusion and is unavailable in that configuration.

Enable `audio.microphone: true` with WebRTC in `transports`. A playing WebRTC session, confirmed backchannel, instance audio policy and `audio.talk` rights must allow talk. Press/hold the microphone control (PTT) or choose toggle deliberately. Approve the browser microphone prompt and check the active indication. No microphone is acquired by opening a card. Hidden/offscreen/blur, release/cancel, reconfiguration, removal and transport change stop capture. Reconnect never restarts talk automatically. A permission prompt, local meter or negotiated sender alone does not prove the physical camera speaker received audio.

## WebRTC reachability and fallback

HTTPS/WSS secures signaling; ICE still needs reachable candidates between the browser and managed go2rtc. Check LAN routes, NAT, firewall and the server's advertised ICE/STUN/TURN configuration. **A TLS reverse proxy is not TURN and does not relay WebRTC UDP.** A successful SDP POST or connected ICE state alone is not decoded media or physical talk proof. Test from the intended external network as well as LAN, without publishing unrelated go2rtc APIs.

WebRTC → MSE → HLS is the default eligible fallback order. MSE/HLS can increase latency and cannot carry the microphone. Offline/rate-limit cases back off; authorization/privacy and possible opaque WS/native denials are terminal. The card never selects another route to bypass a denial. A camera may support receive audio while lacking a compatible backchannel. Physical talk, Safari and Companion microphone acceptance remain unverified until separately recorded on actual devices.
