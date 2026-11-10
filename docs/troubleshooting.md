# Troubleshooting

Start with the [version/evidence matrix](../README.md#verified-scope) and [connectivity recipe](connectivity.md). Never paste raw request headers, cookies, credentials, SDP, source URLs or private hostnames into a public issue. Include sanitized card config, exact versions, transport/provider, fixed diagnostic code/status, whether the HA origin is internal/external, and whether the media was generated or a physical test camera. Review even redacted diagnostics before sharing.

| Symptom | Check / action |
| --- | --- |
| Custom element does not exist | Check exactly one module resource, the exact `lightnvr-camera-card.js` filename and successful JavaScript response. Reload frontend; for manual upgrades change the cache query. Restart HA after first creating `www`. Remove duplicate manual/HACS/Marketplace registrations. |
| Marketplace cannot identify/download repo | Confirm the verified branch bundle has been published before the first release. Use the complete public GitHub URL and Dashboard type. GitHub authorization/rate limits are distinct from card/NVR login. Latest HA uses Settings → Marketplace, not a new legacy HACS install. |
| HACS has no matching file | No-release installs require `dist/lightnvr-camera-card.js` on the default branch. Tagged releases require the matching asset. Source code alone is insufficient. See [packaging strategy](hacs-release.md). |
| Login fetch/CORS failure | The tested baseline rejects cross-origin JSON preflight. Route the NVR prefix on the active HA origin. TLS on a separate NVR hostname does not change browser origin. |
| WSS upgrade denied / MSE terminal | Preserve exact public Host/Origin, scoped cookies and WS upgrades through the verified helper. Adding CORS does not change lightNVR's WS origin policy. Do not retry through a raw go2rtc gateway. Opaque policy-capable failures stay terminal. |
| HTML/404 instead of JSON | Check prefix/upstream root and proxy routing. A login page or HA fallback HTML is not an API response. Discovery errors are not bypassed by supplying `source`. |
| 401 / expired login | Reauthenticate when prompted. Automatic reauthentication is bounded and writes are not replayed. Check scoped cookie delivery/trust, not bearer-token assumptions. |
| 403 / privacy / permission denied | Review the individual lightNVR account's live/listen/talk/action grants and privacy state in NVR. Denials stop fallback. UI control availability is not permission. |
| Another card's identity conflicts | Use separate isolated prefixes for different NVR users. Release holders of the old credential scope before replacing credentials. |
| MFA/password change | Complete supported interactive TOTP challenge; change passwords in NVR UI. Forced inline MFA without a challenge and remembered-device cookies are not established by this setup. |
| HLS playlist opens but segments fail | Preserve prefix and session credentials for every child/init/segment. Do not append passwords to URLs. Provider is independent of fallback; native requires discovered exact main plus permitted listening. |
| No talk control / insecure context | Open HA itself using trusted HTTPS, allow microphone access and enable `audio.microphone`. Verify WebRTC, backchannel, instance audio policy and talk grant. Arbitrary HTTP LAN is unsupported. |
| Microphone active but camera silent | Local capture is not backchannel proof. Check camera codec/backchannel compatibility and a physical observer; test ICE reachability from this network. Physical talk is not yet an accepted support claim. |
| WebRTC connects but no picture | Check decoded frames/codec and ICE media reachability, not just SDP/ICE status. TLS proxying does not relay UDP or provide TURN. |
| Playback works on LAN, not remotely | Confirm the active external HA origin routes the prefix, certificate trust, and NAT/firewall/ICE candidates. Internal/external Companion URLs may select different origins/cookie jars. |
| Silent video / autoplay blocked | Use Listen/Play locally, check OS output and receive rights/codec. Enabling microphone does not grant listening. |
| Fallback loses microphone | Expected on MSE/HLS. Restore permitted WebRTC explicitly; microphone never restarts automatically. |
| Older server / empty inventory | Empty authorized inventory can be valid. A missing summary API currently blocks playback, even manual sources. No old-server/admin-discovery bypass is provided. |
| HA resize/visibility schema errors | Use `playback_visibility` for pause policy and `visibility: [...]` for native conditions. Preserve HA layout metadata. Replace a stale cached bundle if it still rejects these fields. |
| Proxy settings revert / YAML edits ignored | Current HA HTTP settings are UI-managed; confirm after restart before rollback. YAML imports only once. Follow the [official HTTP migration guide](https://www.home-assistant.io/integrations/http/). |
| Snapshot fails / PTZ unavailable | Snapshot requires authorized fetch or permitted origin-clean decoded canvas; denial never falls back. PTZ needs a canonical discovered camera, hardware support and permission. Local digital zoom is separate. |
| Timeline/dewarping missing | Set `viewer_url` to the actual NVR web UI root for links. The API helper does not serve its HTML. Camera-specific fisheye/dewarping and management stay in that UI. |

Rate limits and offline cameras back off with a bounded budget; use local retry after resolving the cause. Source refresh is a separate confirmed server action, never automatic recovery. The tested upstream caches some media authority for approximately 30 seconds; the proxy preserves this policy and does not promise instant revocation. [Actual upstream/proxy evidence](connectivity.md#tested-versions-and-reproducible-validation) records that boundary.
