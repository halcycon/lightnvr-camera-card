# Operator handoff

The card uses the existing lightNVR-managed go2rtc. It implements URL/account discovery, one camera per card, native HA grids/Sections, configurable WebRTC → MSE → HLS, local speaker/volume, gesture-driven PTT/toggle, snapshots, digital zoom, capability-aware camera controls and a visual editor with exact legacy migration. Camera-specific dewarping and recording browsing remain in lightNVR.

Read [verification](verification.md) before assigning device or installation support. Actual current/older HA playback and editor checks passed with generated media; authenticated store installation and physical two-way audio remain unverified. The public repository and development bundle are separate from a tagged release or default catalog listing.

For deployment, follow [connectivity](connectivity.md) and [TLS/two-way audio](tls-and-two-way-audio.md). A TLS sidecar on the NVR alone does not secure the HA document or solve cross-origin WebSocket/cookie restrictions. Full playback uses a scoped path on the HA origin; configure trusted proxies precisely. Camera talk also needs backchannel permission and reachable ICE. Credentials stored in dashboard configuration are visible to readers of that configuration; session storage requires interactive reauthentication.

For maintenance:

1. Follow [development setup](development.md), then use Tailor’s `just lint`, `just test` and `just build` entry points. Node 22.22.2/npm 11.8.0 remain the regular CI baseline.
2. Reproduce actual probe/proxy/HA acceptance with generated fixtures, sequentially; [instructions](../tests/e2e/README.md). A missing-fixture skip is not a compatibility pass.
3. Build with `npm run build` (default `dist`) or an explicit private `LIGHTNVR_BUILD_DIR`. Run `npm run check:release` against that same directory. Inspect the single module and embedded notices.
4. Review and explicitly update only the verified `dist/lightnvr-camera-card.js` when publishing development changes. CI builds into temporary storage and never updates `main` itself.
5. Complete authenticated Marketplace/HACS installation and device checks before broader support claims. A separately authorized `v<package version>` tag triggers the prepared release workflow; verify its attached JS, LICENSE, notices and checksums. Submit to the default catalog only after custom installation works and its requirements are met.

Generated credentials, test configuration, raw browser state and private durable execution records are intentionally excluded from Git. The coordinator retains them locally for recovery. No user dashboard, production sidecar or NVR was modified. Fixture cleanup targets only containers whose descriptor, label and loopback binding match; it does not prune images or unrelated services. Native worker tabs and the control board remain available for inspection.
