# Isolated upstream connectivity receipt (T1)

Verified 2026-11-09 using real lightNVR HTTP handlers and managed go2rtc, with an owned FFmpeg virtual test pattern, ephemeral container database and generated fixture credentials. No production NVR or camera was contacted. This is a connectivity/protocol proof, not decoded-video, physical talk, browser support or deployment acceptance.

## Exact baseline and version matrix

| Component | Observed version / support evidence |
| --- | --- |
| Research source | opensensor/lightNVR `8983888a19fef2040c48eee0a4ce56db5dafeb85` (web 0.48.0); source inspected, not built/run at this exact SHA |
| Real tested server | Official `ghcr.io/opensensor/lightnvr` 0.48.0; OCI revision `4e578c1dac4a21688b420c8fc852f741d62efd2e` |
| Reproducible image reference | `ghcr.io/opensensor/lightnvr@sha256:16303e3b8116fa8fbc565d0548b54bb81a4062f9d9a3fc8961e895b5d8191c11` |
| Local amd64 manifest digest | `sha256:3d28fc1a9ef395dfc5a7bf7e8013964f1c330ff10b6501240726dfc3f039c56b` |
| Managed go2rtc | Image binary reports `1.9.15+dev. () linux/amd64`; source gitlink `9ca672a5d25f3bfca805cebcb835b7433d65e64f` is identical at both lightNVR revisions. Binary string has no embedded commit; exact binary-source equivalence beyond official image provenance is unverified |
| Browser | System Chromium 156.0.8078.73, driven by Playwright 1.56.1 on Linux |
| Container runtime | Podman 6.1.3 with crun 1.30.1; private internal network, HTTP published only on host loopback |
| Actual installed NVR / older releases | Unknown, unverified; no support claim from version number alone |
| HA/HACS, Traefik/nginx, TLS/WSS, Firefox/Safari/Companion | Not exercised in T1; T3/T10 must record actual versions and results |

Coordinator authorized using the versioned official image as a distinct baseline after the research commit's `sha-8983888` image tag was absent. A bounded source-build attempt failed on sid libcurl/libbrotli development dependency resolution; no apt repair or upstream modification was made. A git comparison of the two revisions returned no differences for all of `src/web`, `src/database/db_auth.c`, `src/video/go2rtc`, `web/js/utils/stream-summaries.ts`, `web/js/types/core.ts`, `docs/api/contracts`, or the go2rtc gitlink. This ties the reviewed relevant paths to the tested revision without calling the image the research commit.

Reproduce the comparison after cloning upstream and fetching both revisions:

```sh
git diff --name-only 8983888a19fef2040c48eee0a4ce56db5dafeb85 4e578c1dac4a21688b420c8fc852f741d62efd2e -- src/web src/database/db_auth.c src/video/go2rtc web/js/utils/stream-summaries.ts web/js/types/core.ts docs/api/contracts go2rtc
```

## Observed browser results

| Request / behavior | Result | Content type |
| --- | --- | --- |
| Same-origin POST `/api/auth/login` | 200; JSON success/redirect/must_change_password; no bearer/session token property | application/json |
| Login cookie | `session`, HttpOnly, SameSite=Lax; proxy scopes Path to `/lightnvr/front/`; absent from HA root cookie selection | not exposed to document.cookie |
| Direct cross-origin login preflight OPTIONS `/api/auth/login` | 404; browser fetch rejects | application/json |
| Direct Basic inventory preflight OPTIONS `/api/streams` | 404; browser Basic fetch blocked | application/json |
| Same-origin Basic fetch of live inventory | 200, without cookies | application/json |
| Cookie GET `/api/streams?summary=true&surface=live&page=1&page_size=100&sort_by=name&sort_order=asc&availability=all` | 200, generated camera and numeric total_pages | application/json |
| Authenticated direct cross-origin browser `/go2rtc/api/ws?src=…` | 403 origin rejection, after real same-origin NVR login seeds a valid cookie | application/json at server; browser WS evidence exposes status, no MIME |
| Same-origin proxy browser WS on same route | 101/open; public Host equals browser Origin authority | upgrade has no content type |
| POST `/go2rtc/api/webrtc?src=…`, application/sdp | 201; body starts v=0 and is accepted by RTCPeerConnection.setRemoteDescription, actual browser-generated recvonly video offer | application/sdp |
| GET `/go2rtc/api/stream.m3u8?src=…&mp4=flac` | 200; master URI `hls/playlist.m3u8?id=…` | application/vnd.apple.mpegurl |
| HLS child `/go2rtc/api/hls/playlist.m3u8?id=…` | 200 through proxy prefix, same session cookie | application/vnd.apple.mpegurl |
| Anonymous HLS child with cookies omitted | 401; no bypass through child path | application/json |
| HLS init and segment | 200 through prefix, credential-bound query retained | video/mp4; video/iso.segment |
| Native `/hls/generated/index.m3u8` | 200 valid playlist route (may be empty startup placeholder) | application/vnd.apple.mpegurl |
| Hostile Origin at prefix edge | 403 | no response body required |

Direct fetch denial is the observed preflight failure, not a claim that Basic authentication is unsupported by the server. Fetch headers do not authenticate browser WebSocket or native video. Valid direct cookie WS was tested separately from the proxy session jar, so the refusal demonstrates the origin check rather than merely missing credentials. Chromium CDP/browser-console evidence retains only numeric WS statuses, never URLs, cookies, raw errors or frames.

The frozen inventory wire schema selects name/camera_uuid, enabled/status/privacy, transport hints, has_sub_stream/backchannel/PTZ flags and related credential-free fields. The real response contains `streams`, `total`, `page`, `page_size`, `total_pages`; clients must walk all pages. T1's real fixture has one stream; multi-page client behavior is T2's test responsibility. Capabilities and action grants are not interchangeable; missing flags stay unknown. No `/go2rtc/api/streams` discovery request is made.

## Feasible full-support prefix design for T3

The tested routing helper is `tests/probes/proxy.mjs`, a proof implementation for packaging into a hardened recipe in T3. It forwards to lightNVR HTTP, never directly to its managed go2rtc port. It demonstrates:

1. Route only a selected NVR prefix; strip it on upstream requests. Preserve the browser-facing Host, leave Origin unchanged, and reject an Origin that does not exactly match the allowed public origin before forwarding. T3 adds trusted HTTPS/WSS forwarding and a configured public Host allowlist; do not trust arbitrary forwarded headers.
2. Forward only the selected scope's session cookie. Rewrite Set-Cookie Path to that exact trailing-slash prefix, remove upstream Domain and preserve HttpOnly/SameSite/Secure policy. HA routes never receive the NVR cookie. Separate prefixes isolate identities. T3 still must test two NVR/user scopes and duplicate-cookie ambiguity; reject conflicts rather than silently switch identity.
3. Forward SDP and authenticated WS Upgrade unchanged. A matching public Host/Origin passes the existing upstream check. Do not rewrite Origin to force a foreign browser through it or inject server credentials.
4. Rewrite playlist URI lines and quoted URI attributes (including MAP/KEY) to stay under the selected prefix. Preserve session IDs/query bytes from master to media/init/segment. Relative go2rtc master children were observed. The helper rejects foreign manifest origins and paths outside go2rtc/HLS. T3 must harden traversal/encoded paths, redirects, MIME variants, size/error limits and timeout behavior before deployment.
5. Rewrite root-relative Location values to the prefix; scope upstream redirects and cookie handling for every response. Native HLS relative children resolve under the native prefix. Native TS segment retrieval/authority, native Safari playback, cookie expiry/revocation, multiple prefixes and TLS were not established by this T1 smoke proof and remain T3/T10 checks.

Traefik StripPrefix alone does not rewrite Set-Cookie/Location/playlist content. T3 can place an nginx or equivalent routing helper behind the existing HA-origin proxy, applying the demonstrated transformations. The HA-serving edge must route this prefix for every intended internal/external access URL; an NVR-only TLS sidecar cannot supply this prerequisite. The proof does not require a lightNVR server change or HA Python integration. If that HA-origin routing cannot be configured, full-support deployment is blocked; direct-origin frontend work cannot solve it.

Primary references: [pinned auth](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/src/web/api_handlers_auth_backend_agnostic.c), [pinned WS](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/src/web/go2rtc_websocket.c), [media protocols](https://github.com/opensensor/lightNVR/blob/8983888a19fef2040c48eee0a4ce56db5dafeb85/docs/api/contracts/media-protocols.md), [Traefik StripPrefix](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/stripprefix/), [nginx proxy/cookie/redirect directives](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).

## Running the proof

```sh
npm ci
node tests/probes/setup-fixture.mjs
# Use the private descriptor path printed by setup; it contains generated fixture credentials.
LIGHTNVR_PROBE_FIXTURE=/tmp/REPLACE/fixture.json LIGHTNVR_CHROMIUM=/usr/bin/chromium-browser LIGHTNVR_PROBE_REPORT=/tmp/lightnvr-T1-receipt.json npm run test:probe
```

Use an installed Playwright Chromium if LIGHTNVR_CHROMIUM is omitted. The script verifies the running Podman container/image revision and accepts only loopback HTTP fixture descriptors. With no descriptor, `npm run test:probe` exits 2 and says INCOMPLETE. A missing browser/container or failed assertion exits nonzero. Setup prints explicit cleanup commands for its uniquely named container/internal network; no production containers are inspected or altered. Raw fixture credentials/config and optional debug errors stay under private temporary paths. The sanitized report contains only versions, booleans, endpoint labels, status and content type; no credentials, SDP, hostnames, source URLs or HLS session IDs.

## Remaining acceptance boundaries

T1 establishes the protocol topology for the exact baseline above. It does not verify deployed/older versions, a restricted viewer permission matrix, MFA/password-change/rate-limit flows against a running server, physical camera control/talk, decoded frames, full native HLS segments, HA/HACS installation or public proxy deployment. T2/T3/T10 must retain those boundaries. Cookie scope is a deployment requirement, not a credential vault; dashboard YAML credentials remain visible to readers of the dashboard config.

## Final T1 validation

The sanitized machine receipt is [connectivity-receipt.json](../tests/fixtures/contracts/connectivity-receipt.json). It records 19 passing assertions on a freshly launched official image. The routing helper is test-only; T3 packages and hardens the demonstrated design.

| Exact command | Result |
| --- | --- |
| `npm ci --no-audit --no-fund` | PASS; 187 packages installed with dev tools. npm reported ESLint 9.39.1 deprecated; lint still passes |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run test:unit -- tests/contracts` | PASS; 23 tests |
| `LIGHTNVR_BUILD_ENTRY=src/contracts/index.ts LIGHTNVR_BUILD_DIR=/tmp/lightnvr-T1-contract-build npm run build` | PASS; temporary contract module built, not an installable card |
| `node tests/probes/setup-fixture.mjs` | PASS after fixing model/config paths and limiting generated INI bootstrap password length to 24 hex characters (upstream buffer is 31 bytes) |
| `LIGHTNVR_PROBE_FIXTURE=<private fixture descriptor> LIGHTNVR_CHROMIUM=/usr/bin/chromium-browser LIGHTNVR_PROBE_REPORT=<private report> npm run test:probe` | PASS; fresh actual upstream fixture, 19 assertions |
| `npm run test:probe` without descriptor | Expected INCOMPLETE, exit 2; no mocked success |

Initial WS status-capture and fixture-bootstrap failures were corrected before the final receipt. The initial source-build failure remains recorded above; no exact-research-SHA runtime claim is made. Full card build/release/install, T3 proxy deployment tests and T10 hardware/media/browser acceptance are unavailable at this T1 boundary, not passed.
