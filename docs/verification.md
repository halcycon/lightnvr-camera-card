# Verification and support boundaries

Evidence updated on 2026-11-11. All media came from generated sources in owned, isolated fixtures. No production NVR or physical camera was accessed. An untested result below limits the corresponding support claim; it is not a synthetic pass.

## Tested versions

| Component | Exact baseline |
| --- | --- |
| lightNVR | Official 0.48.0 image `ghcr.io/opensensor/lightnvr@sha256:16303e3b8116fa8fbc565d0548b54bb81a4062f9d9a3fc8961e895b5d8191c11`, OCI revision `4e578c1dac4a21688b420c8fc852f741d62efd2e` |
| Source research | `8983888a19fef2040c48eee0a4ce56db5dafeb85`; relevant API/viewer files matched the tested image revision. That research commit was not itself built. |
| Managed go2rtc | `1.9.15+dev.`, fork gitlink `9ca672a5d25f3bfca805cebcb835b7433d65e64f`; see [upstream contract](upstream-contract.md) |
| HA | Actual Container 2026.11.1 and 2026.10.4; immutable image references in [fixture setup](../tests/e2e/setup-ha.mjs) |
| HACS | 2.0.5 source filename-selection behavior and legacy setup form; authenticated store installation untested |
| Browser | Chromium 156.0.8078.73 on Linux |
| Proxy | Traefik 3.7.17 plus scoped Node 22.22.2 helper for the proxy suite; Node TLS plus the same helper for HA acceptance |
| Build | Node 22.22.2, npm 11.8.0 lockfile, TypeScript 5.9.3, Vite 7.3.8 |

## Results

| Check | Result and evidence |
| --- | --- |
| API/config/UI/lifecycle unit tests | **PASS:** 511 tests in the combined suite, including 120 card/control tests; typecheck and lint passed. The final local rerun used `--maxWorkers=1 --testTimeout=15000` after two five-second startup timeouts during concurrent browser work on a memory-constrained host; no assertions or production timeouts changed. Assertions include cancellation, capture leases, sender/peer teardown, terminal authorization, FIFO admission, snapshots and metadata-only updates. Unit fixtures do not establish hardware behavior. |
| Actual browser authentication/connectivity | **PASS:** 19 assertions against the isolated lightNVR image. Cookie authentication, direct-origin limitations, same-origin signaling, SDP/HLS endpoints and policy dispositions checked. |
| Actual Traefik/helper integration | **PASS:** initial two suites/28 assertions; security follow-up passed five tests, including 29 actual upstream assertions, 44 trap-origin attempts with zero escaped connections, IPv6 and six DNS/IP upstream HTTPS/WS identity checks. Every Node HTTPS harness request now validates the generated CA. The coordinator independently reran the three new security regressions. The upstream media-auth cache lasted about 30 seconds: inventory denied immediately, media after 32 seconds in the expiry check. Immediate media revocation is not promised. |
| Actual adapter decode | **PASS:** forced WebRTC, MSE and bundled hls.js HLS each decoded generated 1920-wide frames through Node TLS/helper inside the rootless container network. Header-only or ICE-connected states were insufficient. This proves that local route, not arbitrary NAT/Internet ICE reachability or camera audio. |
| Actual HA core/card matrix | **PASS on both HA versions:** manual module resource load, panel MSE/HLS real frames, two-camera native grid, removing one card while the other continues, Sections/reload, native visibility hide/restore, metadata-only updates preserving player/auth/listen/volume, local retry preserving volume, and real editor test/discover/select plus redacted two-card grid YAML. |
| Controlled failover and denial | **PASS:** injected WebRTC HTTP 502 led to real MSE; injected HTTP 403 stopped without subsequent fallback media requests. These are labelled proxy fault injections, not claims of a real restricted-role server test. |
| Passive microphone behavior | **PASS:** a browser counter survived navigations and observed zero `getUserMedia` calls during mounting, discovery, layout/reload and fallback. This does not prove physical PTT reception. |
| Reusable HA runner | **PASS:** public Playwright runner completed 13 named checks on each freshly generated HA 2026.10.4 and 2026.11.1 fixture, including actual JPEG snapshot download and editor image preview. The disposable setup/onboarding flow passed, including explicit managed HTTP confirmation. The 2026.11.1 receipt identifies the HA-tested artifact; the publication banner was subsequently expanded with complete embedded-dependency notices while the entire player program remained byte-identical. See [reproduction instructions](../tests/e2e/README.md). |
| Packaging | **PASS:** four example card configurations match the schema; one standalone ES module has no external static/dynamic imports or source map. Release shape/checksums and five cases using HACS 2.0.5's exact filename-selection method passed. Complete project/dependency license notices are embedded in the JS and checked after bundling. |
| Workflow validation | **PASS locally:** actionlint 1.7.12 and shell syntax; reviewed commit/digest-pinned actions. Hosted outcomes are available from the repository’s [Card CI runs](https://github.com/halcycon/lightnvr-camera-card/actions/workflows/card-ci.yml); local checks alone do not establish a hosted pass. |

Chromium's advertised native HLS support returned successful HTTP requests but decoded no frames in the initial integration check. The corrected adapter chooses bundled hls.js up front when supported; native HLS is selected only when that engine is unavailable and the required cookie/permission route is supported. The zero/zero byte-range sentinel was also corrected using actual fragment responses. An opaque native/WS failure remains terminal when it could hide a denial; no alternate-route bypass was added.

During acceptance, the first legacy HA test returned a missing resource because `www` was created after HA started. Restarting that owned fixture made the module available and the complete matrix passed. The reusable setup creates `www` before startup. Modern HA managed HTTP configuration must be promoted after a trial; changing already imported YAML alone is insufficient.

## Not tested / release claim limits

- Authenticated current Marketplace or legacy HACS custom-repository installation, upgrade, version switching and matching tagged-asset download. The optional GitHub device authorization expired without completion. Public metadata/source behavior and manual resource loading are separate evidence.
- Physical camera speaker receiving PTT/toggle audio, actual microphone quality/latency/echo, camera backchannel compatibility, motorized PTZ/presets/day-night and physical recording behavior.
- Firefox, Safari on macOS/iOS, native Safari HLS, Android/iOS Companion WebViews, and their microphone/fullscreen/autoplay behavior.
- Production deployment, the user's installed lightNVR version, older discovery APIs, a real restricted-account inventory/control matrix, NAT/TURN or remote cloud-origin routing.
- Four-card 30-minute soak, 50 measured mount/removal cycles, network switching/restart and source rename/delete under real load. Bounded logic and unit tests are not a measured endurance pass.

No public release tag or catalog submission is created by these checks. A default Marketplace/HACS listing requires separate review. Users testing this development build should use the documented supported topology and report the exact server/browser versions.

## Development artifact

The final standalone module is `dist/lightnvr-camera-card.js` (1,401,363 bytes). Its SHA-256 is `d0e938a115c556352392d9b3e5f2b3ff8922b904799506c07f891fa04cd2672f`. The matching release-shape check requires the complete current LICENSE and THIRD_PARTY_NOTICES text inside the JS.

The prior HA-tested artifact had SHA-256 `e3bd48505c762870181263c347b2d1d69affbc224cc22862b4b04b82556c6e67`. Rebuilding with the expanded license banner left all JavaScript after that banner byte-identical. The [security review](security-review.md) records the proxy hardening and the three specific bundled-library false positives; no CodeQL query or path was disabled.

## Tailor tooling follow-up — 2026-11-11

Tailor 0.6.0 was checksum-verified, previewed and applied again to finish native tooling adoption; see [development and ownership](development.md). `just lint` (Actionlint/Oxlint/Prettier/TypeScript), `just test` (511 tests) and `just build`/release checks passed locally. The dependency audit returned zero findings. Three existing authority/IPv6/upstream-TLS regressions passed independently.

The rebuilt standalone module parses with zero external imports. Its canonical JavaScript syntax tree is identical to the prior `d25c7444415d981cea02f6b29a6da708ba385c3aa653b374bab82c73ecb2b14a` artifact after ignoring locations and literal spelling. Formatting changed emitted whitespace, so the actual HA 2026.11.1 suite was rerun: all 13 checks passed against the current artifact SHA above. An initial Sections timeout did not recur in either the diagnostic rerun or final standard Playwright run; no product code fix was made for that timeout. Legacy HA evidence remains the earlier baseline.

The new Nix CI job evaluates the committed flake and runs the actual lint/test/build commands inside its development shell. Its hosted result is published alongside the regular Node/HACS jobs in [Card CI](https://github.com/halcycon/lightnvr-camera-card/actions/workflows/card-ci.yml). Local Nix is not installed on the development host, so the hosted result is the Nix verification source.
