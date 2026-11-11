# Connect to an NVR-side gateway

Use this topology when HA and lightNVR have different HTTPS origins within the same site, for example `https://ha.example.test` and `https://nvr.example.test`. HA serves its dashboard normally. The card connects directly to an authenticated gateway prefix on the NVR hostname. Taking down the NVR stack affects camera cards, not the HA HTTP service or tunnel.

```text
Browser ── existing HA URL/tunnel ── Home Assistant
    └──── https://nvr.example.test/ha-card/ ── NVR Traefik
                                               └── scoped gateway ── lightNVR
```

This requires a small Node gateway beside lightNVR, not a second go2rtc instance or HA integration. The existing lightNVR API remains the authentication and camera-permission authority. No lightNVR source patch is required for the tested server baseline. The helper is the independently written [router.mjs](../examples/proxy/router.mjs).

## Configure the NVR edge

1. Run the helper from [compose.yaml](../examples/proxy/compose.yaml) behind the **NVR-facing** TLS edge. Give that edge the dedicated trusted network address `.2` and the helper `.3` as illustrated there. The helper also needs access to the existing lightNVR backend network; attach it to that network if using a container service name. Do not publish helper or go2rtc ports.
2. Start from [router.cross-origin.example.json](../examples/proxy/router.cross-origin.example.json). `origins` contains the NVR's exact public HTTPS origin/Host. `clientOrigins` contains each explicitly allowed HA HTTPS origin. These are separate lists: accepting the HA Origin does not accept the HA Host as a destination. Set `upstream` to the existing lightNVR root, never raw go2rtc.
3. Merge [traefik.cross-origin.dynamic.yaml](../examples/proxy/traefik.cross-origin.dynamic.yaml) into the NVR edge's file configuration. Reuse its existing NVR certificate/resolver and HTTPS entrypoint. Preserve the normal NVR UI route. The more specific `/ha-card/` router must take priority. Keep the forwarded-header trust and exact socket-peer checks in the [helper's security reference](connectivity.md#routing-and-security-behavior).

No HA hostname router, HA proxy trust, HA TLS change, HA internal DNS change, or cloudflared route change is needed. The browser must reach the NVR hostname internally and externally with a trusted certificate. An upstream HTTP hop is appropriate only on a protected backend network; verified HTTPS is supported for a remote backend.

## Card configuration

```yaml
type: custom:lightnvr-camera-card
server: https://nvr.example.test/ha-card/
viewer_url: https://nvr.example.test/
stream: front_door
credential_storage: session
transports: [webrtc, mse, hls]
audio:
  listen: true
  muted: true
  microphone: true
  talk_mode: ptt
```

Use Connect/discovery with the individual NVR username/password. Multiple cards or native grids can share this prefix/session. Keep distinct prefixes/cookie names for separate users. Discovery and action grants remain enforced by lightNVR. The normal NVR UI's root `session` cookie is not forwarded by the gateway, and the gateway cookie is not sent to the HA hostname.

## Browser and security contract

- Only exact configured HTTPS client Origins are accepted. Hostile/null/duplicate Origins, untrusted edge peers, ambiguous paths and cross-site fetch metadata remain rejected. Wildcards are not supported.
- Valid preflight requests are answered locally for the selected API/media scope, with explicit methods and `Content-Type`/`Range` request headers. Allowed clients receive exact `Access-Control-Allow-Origin`, credentials support, `Vary: Origin` and exposed media/retry metadata, including on upstream authentication/policy errors. Other clients receive no CORS permission.
- The helper validates the incoming browser Origin before translating Host/Origin to the configured upstream authority. It never injects an account password or forwards HA/sibling cookies. Only the selected scoped cookie becomes the lightNVR session.
- A secure, HttpOnly, host-only, SameSite=Lax cookie carries the session at the NVR prefix. This is **same-site cross-origin access**, not general third-party cookie support. HA and NVR on unrelated registrable domains, mixed HTTPS/HTTP sites, restrictive device policies, or browsers blocking the cookie are not covered. Login/verification failure must remain a failure; no raw media bypass is provided.
- Credentialed responses expose the exact `X-LightNVR-Card-Gateway: same-site-session-v1` marker. The client retains the factual `sameOrigin: false` profile and only permits cross-origin cookie media after observing that explicit HTTPS gateway capability. Ordinary cross-origin servers remain excluded from MSE. Basic mode remains restricted to tested same-origin fetch.
- hls.js uses the authorized credentialed loader for all playlists, keys, initialization and media segments. Native HLS can be eligible with the gateway marker, scoped cookie route and existing source/listening requirements, but actual Safari/Companion playback has not been established.
- Camera permissions/privacy and terminal-denial rules remain unchanged. CORS and the capability marker do not grant camera access. The existing endpoint, playlist, redirect, destination-authority and timeout restrictions still apply.

Microphone/PTT still needs trusted HTTPS on the HA document and NVR signaling, a deliberate user gesture, browser permission, backchannel support and the NVR talk grant. A TLS gateway is not TURN: WebRTC media needs reachable ICE candidates independently. MSE/HLS fallback cannot send microphone audio.

## Verification boundary

The reproducible `NVR-side gateway` test in `npm run test:proxy` uses two owned TLS hostnames in one site, a third hostile origin and a separately allowlisted cross-site origin. It builds and loads the real card, uses an isolated official lightNVR server and generated media, and checks credentialed login/preflight, authenticated WSS/MSE, HLS decoding, WebRTC SDP, cookie isolation, denied origins and an independently responding HA-origin page after the gateway stops. That page is an HTML fixture, not an actual HA instance. Physical talk, Companion, Safari and production deployment require separate acceptance.

The [HA-origin prefix recipe](connectivity.md) remains an optional alternative for deployments that already have an appropriate HA-facing edge. It is not a prerequisite for the NVR-side topology above.
