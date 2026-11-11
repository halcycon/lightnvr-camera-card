# Code scanning review

Reviewed against the 2026-11-10 development build and its locked dependencies. CodeQL analysis success and the absence of npm advisories are separate from alert triage. No CodeQL query, source path or severity check was disabled for this review.

## Request authority and test certificates

CodeQL reported request-forgery findings in the deployment router and isolated proof helper, plus disabled certificate validation in a proxy-test utility. The deployment router already rejected ambiguous paths before URL resolution; the proof helper had weaker assumptions. Both now use fixed destination options and were verified with the configured protocol, hostname and port independently of the request-target path for HTTP and WS. This makes destination authority independent of request text. The proof helper additionally accepts only loopback HTTP upstreams.

The proxy-test utility now uses the generated certificate as its CA for every HTTPS request, including readiness and rejection checks. A separate successful certificate probe did not justify disabling verification elsewhere. The real 19-check protocol probe and five-test proxy run passed. The coordinator independently passed the three new authority/IPv6/TLS regressions; the trap saw zero HTTP/WS requests and zero TCP connections. The exact follow-up results are recorded in [verification](verification.md).

External NVR ingress support adds explicit per-scope `forwardAuthority: "upstream"`. It translates outbound Host, supplied Origin and forwarded authority to the configured upstream only after validating the socket peer, exact public Host/Origin, forwarding headers, route and scoped cookie. It never translates a hostile or null browser Origin into an accepted request. The default retains the public authority. Destination URL/certificate identity remains fixed by configuration, and authentication remains lightNVR's responsibility; the helper injects no account credentials. Owned TLS tests model an external hostname-routed ingress and verify HTTP/WS authority translation, preserved upstream 401 denial, certificate/SNI identity and rejection of hostile Origins before forwarding. They do not establish production Internet/NAT compatibility.

## Three bundled-library findings

Existing card tests also verify that a server detection label containing `<script>` renders as text with no script element.

These findings were reviewed as false positives for the current application usage, rather than suppressed by excluding the bundle or its queries:

| Finding | Reviewed code and boundary |
| --- | --- |
| `js/insecure-randomness` in hls.js player `sessionId` | hls.js 1.7.4 calls the prebundled SVTA UUID utility. It prefers `crypto.randomUUID`, then a blob UUID, before its compatibility fallback. The reviewed UUID flows into CMCD `sid`, interstitial `_HLS_primary_id` and player correlation. It is not the lightNVR authentication session, a password, bearer token or encryption key. This card authenticates using the server's HttpOnly cookie; no authorization decision uses this UUID. EME `MediaKeySession.sessionId` is a different browser-owned value. |
| `js/bad-tag-filter` in lit-html `commentEndRegex` | lit-html 3.3.3 is recognizing positions in authored static template strings, not sanitizing arbitrary camera HTML. This card uses ordinary Lit text/property bindings and does not import `unsafeHTML`/`unsafeSVG` or construct template source from server/configuration strings. Untrusted values do not enter the template parser as markup. The comment delimiter regex is not this application's security sanitizer. |
| `js/bad-code-sanitization` in Zod `Doc.compile` | Zod 4.6.7's object-parser compiler emits code for the statically authored schemas in `src/contracts` and `src/api/client.ts`. Its generated body closes over schema parsers; configuration/network values remain parser input. This application neither imports a user-provided schema nor turns camera names, credentials, YAML or HA metadata keys into a new object schema/program. Record values and unknown metadata remain data. The generic library compiler's existence is not an application code-injection path. |

Reproduction uses the exact npm lockfile. Relevant distributed sources are `hls.js/src/hls.ts`, `controller/cmcd-controller.ts`, `loader/interstitial-event.ts`; `lit-html/development/lit-html.js`; and `zod/src/v4/core/doc.ts` and `schemas.ts`. The pinned [hls.js package manifest](https://github.com/video-dev/hls.js/blob/v1.7.4/package.json) identifies its prebundled SVTA dependencies. Complete upstream notices, including dependencies already built into hls.js, are retained in [third-party notices](../THIRD_PARTY_NOTICES.md) and the standalone JS banner.

The registry advisory lookup for the six exact dependency versions prebundled inside hls.js returned no affected advisories on 2026-11-10. That lookup complements, rather than replaces, the application-specific data-flow review and installed-tree audit.

The three specific GitHub alerts are eligible for false-positive triage with these explanations. This is not a blanket dependency allowlist: dependency updates, dynamic template/schema construction, a new use of the correlation UUID for authorization, or changed data flow require a new review. Newly discovered findings remain subject to analysis.
