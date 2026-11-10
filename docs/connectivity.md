# Browser connectivity and the same-origin recipe

The supported reference topology routes an NVR prefix through **the reverse proxy that serves the Home Assistant dashboard origin**:

```text
Browser: https://ha.example.test/
    ├── HA routes ──────────────── existing HA service
    └── /lightnvr/front/ ─ Traefik ─ scoped routing helper ─ lightNVR HTTP
                                                               └── managed go2rtc
```

`ha.example.test` and the NVR service names in these examples are placeholders. Configure the card's `server` as `https://ha.example.test/lightnvr/front/`, with the trailing slash. Login still uses the individual lightNVR user's credentials and existing lightNVR grants. No administrator credential is configured in the helper. No additional go2rtc is installed, and its raw HTTP API/port must remain private.

**Deployment prerequisite:** every dashboard origin used by the browser must route these prefixes to the helper. A TLS sidecar attached only to the NVR cannot create routes on an existing HA origin. If you cannot change the HA-serving edge, this full-support topology is unavailable. Adding CORS, rewriting a hostile Origin, or publishing go2rtc cannot repair that prerequisite.

## Files and integration

- [compose.yaml](../examples/proxy/compose.yaml) runs the helper with no published ports, a read-only filesystem, dropped capabilities, and UID/GID 65534.
- [router.example.json](../examples/proxy/router.example.json) specifies exact allowed HTTPS origins, trusted edge peer IPs, nonoverlapping prefixes, unique cookie names, and existing lightNVR HTTP roots.
- [traefik.dynamic.yaml](../examples/proxy/traefik.dynamic.yaml) is a file-provider fragment to merge with the existing HA edge. Its explicit prefix router has priority 1000; check priorities against your HA routers. `passHostHeader: true` preserves the browser's authority, including a nonstandard public port.
- [traefik.static.example.yaml](../examples/proxy/traefik.static.example.yaml) shows the corresponding HTTPS entrypoint and forwarded-header policy. Preserve the existing edge's other entrypoints, HA services and certificate resolver.
- [router.mjs](../examples/proxy/router.mjs) implements the required cookie/Location/playlist transformations. Traefik StripPrefix alone does not perform those response transformations; do not attach StripPrefix in front of this helper.

Prepare a private copy of the JSON configuration outside this repository. Replace the origin and upstream placeholders with addresses the helper can actually resolve and reach. Upstreams must be **lightNVR's HTTP service root**, such as its port 8080, never managed go2rtc's port 1984. Both `http:` on a protected private network and verified `https:` are accepted. Node verifies upstream HTTPS certificates by default; mount a private CA and set `NODE_EXTRA_CA_CERTS` if needed. Do not disable certificate verification. Upstream HTTPS with a private CA is not part of the real-server runtime receipt below; the tested upstream hop is isolated HTTP.

The sample helper network is an external network named `lightnvr-edge`. The example reserves `172.31.253.2` for the HA-facing Traefik edge and `.3` for the helper. Choose an unused subnet and adjust the Compose IP and JSON `trustedPeers` together. Attach only this edge and helper to that dedicated network. Allow the helper to reach the existing NVR addresses; if the NVR is reachable only on another container network, attach the helper to that backend network as well. Do not publish helper or go2rtc ports. The tests use loopback peers with Linux host networking instead of this illustrative deployment subnet.

Mount the dynamic fragment into the existing edge's file-provider directory and mount its TLS certificate/key paths, or use your existing trusted certificate resolver. The certificate must be valid for the dashboard origin and trusted by desktop and Companion devices. The helper config and source must be readable by UID 65534 inside their mounts; the JSON contains routing addresses, not login credentials. Set `LIGHTNVR_ROUTER_CONFIG_FILE` to that private JSON's absolute path when using the helper Compose file. Validate it before starting anything:

```sh
LIGHTNVR_ROUTER_CONFIG_FILE=/absolute/private/router.json \
  docker compose -f examples/proxy/compose.yaml config --quiet
```

Starting/reconfiguring a real edge is a separate operator deployment step. These examples and tests do not change an existing sidecar, HA installation, or production NVR.

## Routing and security behavior

| Concern | Behavior |
| --- | --- |
| Public Host and Origin | Require an exact configured Host and HTTPS origin. Preserve browser Origin unchanged to lightNVR. Reject hostile/null Origin and cross-site fetch metadata. A browser WS upgrade requires an Origin. Origin-less HTTP tools still require the trusted peer, allowed Host, and lightNVR authentication. |
| TLS forwarding | Accept forwarded headers only from an explicit socket-peer allowlist. Require `X-Forwarded-Host` to match Host and `X-Forwarded-Proto: https`; on WS upgrades only, Traefik 3.7.17's `wss` is also accepted. Recreate trusted HTTPS forwarding upstream, remove client forwarding/identity hints. Keep Traefik `forwardedHeaders.insecure: false`; do not trust arbitrary clients or a whole LAN. |
| Cookie isolation | Rename upstream `session` to a unique `lnvr_*` name per prefix, strip Domain, set the exact trailing-slash Path, enforce Secure/HttpOnly and at least SameSite=Lax (preserve Strict). Preserve expiry and deletion attributes. Forward only the selected cookie as upstream `session`; discard HA, sibling-prefix, and root `session` cookies. Reject duplicate selected cookies/header ambiguity. The browser sends no NVR cookies to HA routes. |
| Identities | Two prefixes have separate login sessions even when both target one NVR. A user's HLS lease cannot be used with the sibling prefix's session. Cookie paths isolate request selection; the shared browser origin is still one trust boundary, and dashboard configuration is not a credential vault. |
| MFA / remembered devices | Only `session` is supported and forwarded. `trusted_device` and other cookies are discarded; remembered-device MFA is intentionally unavailable. Interactive authentication policy remains upstream's responsibility. TOTP/password-change flows are not established by this proxy receipt. |
| HLS | Rewrite URI lines and quoted URI attributes, including MAP/KEY, to the selected prefix. Preserve query bytes/session IDs. Resolve relative nested children, root-relative children, and absolute URLs matching the configured upstream. Reject foreign/protocol-relative URLs, paths outside `/hls/` or `/go2rtc/api/hls/`, malformed/unquoted URI attributes, unsafe encodings and traversals. No credentials are appended to URLs. |
| Location | Rewrite root-relative, relative and matching-upstream absolute Location headers into the prefix; reject foreign redirects. The recipe serves API/media, not the full lightNVR web application. A redirect to `/login.html` becomes a scoped URL but that HTML route is not served. API auth callers should send `Accept: application/json`; JSON `redirect` fields are not rewritten or navigated automatically. |
| Endpoints | `/api/*` stays under lightNVR authentication/authorization, including discovery, client-config, ICE and control APIs. Allow only the selected go2rtc gateway endpoints: `/go2rtc/api/webrtc`, `/ws`, `/stream.m3u8`, `/frame.jpeg`, and `/go2rtc/api/hls/*`. Forward `/hls/*` to lightNVR. Reject other `/go2rtc/*` routes, including administrative `/api/streams` and `/api/config`. |
| Upgrades | Preserve the WS handshake and full-duplex frames through Traefik and the helper. The helper neither injects credentials nor turns a denied upgrade into another transport. Active media revocation remains lightNVR's responsibility. |
| Failure bounds | Maximum HTTP request body 2 MiB, playlist 1 MiB, request/header deadlines 30/15 seconds and total upstream HTTP deadline 30 seconds. WS handshake deadline 30 seconds; upgraded streams have no helper idle timeout. Reject compressed/partial successful playlists rather than send unrewritten content. Strip hop headers, upstream CORS/Refresh/Link/Alt-Svc, and stale playlist validators; send `Cache-Control: no-store`. Errors are generic and do not echo upstream details. |

Use a trailing slash on both configured scope and card server URL. Prefixes may be nested, such as `/services/cameras/front/`, but may not overlap each other. Change the edge rules and helper JSON together. Query parameters carry encoded source names without reinterpretation. lightNVR's actual stream-name rules still apply: the tested release accepts letters, digits, dots, underscores and hyphens; a proxy does not add unsupported camera names. Encoded slash, double-encoding, dot traversal and ambiguous separators in request paths are rejected.

The selected upstream's native-HLS handler serves a stream name plus a single filename. Native nested filenames return 404 at routing (observed); do not advertise nested native directories merely because generic HLS rewriting supports nested children. The helper does not create native HLS when go2rtc fails, bypass a 401/403/privacy denial, or change the selected HLS provider.

## Internal, external and Companion HA URLs

| Dashboard access | Required behavior / boundary |
| --- | --- |
| External HTTPS domain | Route the NVR prefix on that domain and allow that exact origin. Configure the card with its matching prefix. |
| Internal HTTPS alias or different port | Route the same prefix on that origin too, add its exact HTTPS origin/Host to the helper and edge rules, and provide a trusted certificate. Different hostnames have separate browser cookie jars and require separate login. |
| Split DNS, same HTTPS name | Prefer the same browser origin inside and outside. Internal DNS must lead to an edge that also routes the prefix. Changing the backend IP does not change browser cookie scope. |
| Direct internal HTTP HA URL/port | This HTTPS-only recipe does not support that dashboard origin. Secure cookies/microphone support cannot be promised; access HA through the configured trusted HTTPS edge. |
| HA Companion internal/external URL switch | The active WebView origin must have a matching routed prefix and card server URL. A fixed external card URL viewed from a different internal HA origin becomes cross-origin. The recipe does not automatically replace a saved absolute server URL when Companion switches URLs; use a consistent HTTPS origin or explicitly configure a matching deployment/profile. |
| HA Cloud or another unconfigurable edge | If that origin cannot route the NVR prefix, this topology is blocked for it. A separate NVR TLS sidecar does not supply the missing same-origin route. |

These are deployment constraints, not a claim of actual HA/Companion device testing. ICE/media reachability is separate: successful SDP HTTP forwarding does not establish WebRTC media paths through NAT/firewalls or physical camera talk. Retain the existing managed go2rtc ICE/TURN configuration and verify decoded media on the intended devices.

## Direct mode: observed boundaries

T1's real Chromium tests against the same upstream baseline establish:

| Direct request from a different browser origin | Observed result |
| --- | --- |
| JSON login with credentials | Preflight OPTIONS 404; browser fetch rejects |
| Basic-auth inventory fetch | Preflight OPTIONS 404; browser fetch rejects |
| Authenticated cookie WS after successful same-origin NVR login | 403 because public Origin authority differs from Host |
| Basic-auth inventory on the same origin | 200; this is fetch-only evidence |
| Login from the NVR's own origin | Session cookie works; ordinary login returns no bearer token |

Basic fetch headers do not authenticate browser WebSocket constructors or native video requests. CORS cannot remove the upstream WS origin check. Direct native HLS, cross-site cookie acceptance, older releases, Firefox/Safari and Companion behavior are not established by these checks. See [T1's upstream evidence](upstream-contract.md) for exact browser statuses and provenance.

## Tested versions and reproducible validation

The [sanitized receipt](../tests/proxy/receipt.json) records the completed T3 run. This is protocol/routing acceptance against generated media, not decoded playback or production deployment acceptance.

| Component | Exact tested baseline |
| --- | --- |
| Traefik | **3.7.17**, official `docker.io/library/traefik@sha256:e15b8921020b4fd81de5746b170dfceec221d2450711449f6427e4692881511a` (Linux amd64 image manifest) |
| Helper runtime | Node **22.22.2**, official `docker.io/library/node@sha256:cb15fca92530d7ac113467696cf1001208dac49c3c64355fd1348c11a88ddf8f` (`22.22.2-alpine`, Linux amd64) |
| Host toolchain | Node 22.22.2 / npm 10.9.7; existing Playwright 1.56.1; no dependency installation during T3 |
| Browser | Chromium 156.0.8078.73, Linux |
| Upstream | Official lightNVR 0.48.0, OCI revision `4e578c1dac4a21688b420c8fc852f741d62efd2e`; image index `ghcr.io/opensensor/lightnvr@sha256:16303e3b8116fa8fbc565d0548b54bb81a4062f9d9a3fc8961e895b5d8191c11` |
| Upstream provenance | Relevant reviewed paths match research SHA `8983888a19fef2040c48eee0a4ce56db5dafeb85`; exact research SHA was not built/run. T1 records managed go2rtc `1.9.15+dev.` and its source/binary provenance boundary. |
| Runtime / Compose | Podman 6.1.3; host Docker CLI absent. Official containerized Docker Compose **5.7.0**, tool image `docker.io/library/docker@sha256:b0d99f37f463c88cae2082083f705210296186c06632d22f6952ed43506ae520` |

The Traefik patch was selected after checking its [official 3.7.17 release](https://github.com/traefik/traefik/releases/tag/v3.7.17); the recipe does not claim all 3.x releases or other architectures. The helper is independently written and uses only Node built-ins. Its cookie renaming is transparent to browser clients that use HttpOnly sessions; no shared card contract change is required.

With the existing dependencies available, start a fresh isolated official-image fixture if an assigned one is not already running:

```sh
node tests/probes/setup-fixture.mjs
# Use only the generated private descriptor printed by setup.
LIGHTNVR_PROBE_FIXTURE=/absolute/private/fixture.json \
LIGHTNVR_CHROMIUM=/usr/bin/chromium-browser \
LIGHTNVR_PROXY_REPORT=/tmp/lightnvr-T3-receipt.json \
  npm run test:proxy -- --output=/tmp/lightnvr-T3-playwright --reporter=list
```

`test:proxy` fails with **INCOMPLETE** when the real fixture descriptor is absent. The harness verifies its loopback port, running state, T1 fixture label and upstream revision before using it. It starts uniquely named T3 edge/helper containers with test-only loopback listeners and no engine socket. It copies the packaged routing fragment/helper into a temporary directory, makes a generated TLS certificate, verifies its CA/IP SAN with Node TLS, and pins that certificate's SPKI for Chromium (no global browser TLS bypass). It uses only generated credentials/test-pattern media. It removes its containers, certificate files and generated native media in cleanup. The T1 fixture is left running for its owner; use only the fixture setup's printed cleanup commands when it is no longer needed. Never run these tests against a production descriptor.

The native media check generates local FFmpeg TS segments and serves them through the real native-HLS handler. It does **not** establish the native camera producer's startup behavior. Session expiry advances only a generated session's `expires_at`/`idle_expires_at` in the isolated fixture database. Inventory immediately returns 401, but the tested upstream deliberately caches HLS/media authority for 30 seconds: stale-cookie media requests can still return 200 inside that window. The harness records those immediate statuses, waits 32 seconds, and requires media/init/segment denial after the window. It does not claim immediate revocation. Logout (which clears the cookie) and cross-session HLS denial are checked separately. This behavior is explicit in upstream's `HLS_SESSION_AUTH_TTL_SECONDS` and `MEDIA_AUTH_CACHE_TTL_SECONDS`; the helper preserves the server policy rather than adding its own authorization cache. The HA root is an owned HTML fixture with cookie observation, not a running HA installation. Generic nested HLS, malformed/foreign manifests, duplicate headers/cookies and response bounds use an isolated HTTP fixture; those assertions are not labeled upstream compatibility proof.

The test Compose file uses the same pinned images/configuration as the Podman harness. Its Linux host-network services consume the harness-generated temporary directory via `LIGHTNVR_PROXY_TEST_DIR`. The automated harness owns startup/cleanup and reserved ports; do not start duplicate Compose services while it runs. Validate the model without an engine:

```sh
docker compose -f examples/proxy/compose.test.yaml config --quiet
```

On the tested host the command above is unavailable because Docker CLI is absent. This equivalent containerized Docker CLI validation passed for both Compose files, without a daemon/socket or network access:

```sh
podman run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  -v "$PWD/examples/proxy:/work:ro,z" -w /work --entrypoint docker \
  docker.io/library/docker@sha256:b0d99f37f463c88cae2082083f705210296186c06632d22f6952ed43506ae520 \
  compose -f compose.test.yaml config --quiet
# For compose.yaml, also pass:
# -e LIGHTNVR_ROUTER_CONFIG_FILE=/config/router.json
# and change the -f value to compose.yaml.
```

T3 also runs `node_modules/.bin/eslint tests/proxy examples/proxy/router.mjs` and `npm run typecheck`. Shared package/lockfile security updates are coordinator-owned. No global lint/build/install, shared dist output, Git/index changes or deployment are part of this task.

Primary proxy references: [Traefik forwarded-header trust](https://doc.traefik.io/traefik/v3.7/reference/install-configuration/entrypoints/), [Host forwarding](https://doc.traefik.io/traefik/v3.7/reference/routing-configuration/http/load-balancing/service/), [StripPrefix behavior](https://doc.traefik.io/traefik/v3.7/reference/routing-configuration/http/middlewares/stripprefix/), and [Docker Compose config semantics](https://docs.docker.com/reference/cli/docker/compose/config/).

## Request-authority and TLS security follow-up

The production HTTP and WS relays now pass separate Node request options: `protocol`, `hostname` and `port` come exclusively from the configured upstream, and `path` is the validated raw request target. Client paths are never resolved into outbound destination URLs. Existing Host/Origin checks, cookie isolation and playlist/Location confinement remain in force. Enclosing IPv6 brackets are removed from `hostname` options; Node retains protocol-specific default ports when the configured URL omits a port. HTTPS uses the configured DNS hostname explicitly as `servername`, independent of the forwarded public HTTP Host. For configured IP addresses, explicit empty `servername` omits IP SNI and leaves normal IP certificate verification enabled. An owned CA-backed TLS fixture verifies HTTP and WS to DNS, IPv4 and IPv6 upstreams while preserving the public HA Host. It uses existing `NODE_EXTRA_CA_CERTS` support; no proxy CA configuration feature is added.

The proof helper also uses fixed destination options. It accepts only generated HTTP fixture roots on IPv4 `127.0.0.1` or IPv6 `::1`, without URL credentials, subpaths, query or fragment. The real probe additionally verifies the project's fixture ownership label, running image and loopback port binding. The proof helper rejects ambiguous authority-like scoped paths before forwarding; its inert HA fixture response for unrelated paths does not proxy anywhere.

Adversarial regression coverage uses a second owned trap origin. Both helpers receive HTTP and WS attempts containing network-path authorities, triple slashes, backslashes, encoded/double-encoded slashes, encoded backslashes, embedded HTTP/HTTPS URLs, userinfo authorities, encoded traversal and absolute-form targets. The trap must receive zero HTTP requests, WS upgrades **and TCP connections**. Positive controls verify byte-for-byte encoded paths/queries and public Host/Origin on the configured upstream. An owned IPv6 loopback fixture separately checks HTTP and WS for both helpers; unsupported IPv6 is reported as unavailable rather than passed.

Every Node HTTPS call in the proxy harness now receives the generated certificate CA, including readiness probes, denied WS upgrades, hostile-origin requests and other rejection checks. Certificate verification is never disabled by the HTTP request helper. Negative TLS checks require rejection of an unrelated owned issuer using the actual fixture CA, and a wrong hostname using the trusted edge CA; a positive check verifies the CA and IP SAN. The generated certificate is also the isolated edge's default certificate, so the wrong-hostname test measures SAN rejection rather than rejection of Traefik's unrelated fallback certificate. The browser retains its existing trust restricted to that generated certificate's SPKI.

The [security follow-up receipt](../tests/proxy/security-receipt.json) records the fresh real probe/proxy runs, adversarial cases, IPv6 result and exact commands. The earlier [T3 receipt](../tests/proxy/receipt.json) remains historical evidence. The measured 30-second upstream media-authorization cache and all HA/device/decoded-media support boundaries above remain unchanged. CodeQL must be rerun separately in CI; regression success does not establish scanner alert resolution, and no findings are dismissed or suppressed by this change.
