# HACS / Marketplace packaging and release preparation

This task prepares metadata, CI and a tag-triggered workflow. It creates **no tag, public release, marketplace/catalog submission or deployment**. Authenticated Marketplace and legacy HACS custom-repository installation/upgrade are not tested. The public 13-check actual-HA matrix passed on 2026.11.1 with generated media; this is separate evidence, not an authenticated GitHub catalog installation/upgrade test. The same actual card matrix also passed on legacy HA 2026.10.4.

## Artifact strategy

Public repository: `halcycon/lightnvr-camera-card`; matching file: **`lightnvr-camera-card.js`**. `hacs.json` explicitly selects it and renders the README. `content_in_root` is intentionally absent/false to allow release assets and `dist` fallback. No `zip_release` strategy is used. The only runtime deliverable is the bundled ES module; no remote imports, code splitting, source maps, fonts or CDN runtime dependencies are required. The Vite configuration places the complete existing LICENSE and THIRD_PARTY_NOTICES.md into the JS license banner because HACS downloads one JS file. Those notices also accompany release distribution as separate files, with SHA256SUMS; retain the banner when distributing the standalone module.

Before the first tagged release, custom installation uses the verified `dist/lightnvr-camera-card.js` checked into `main`. Maintainers explicitly update only that final bundle; other `dist` output remains ignored. Without a published bundle on the default branch, a source-only repository cannot install through the branch fallback. Ordinary CI builds into runner temporary storage and does not update `main`.

For tagged versions, `card-release.yml` runs the same CI/unit/build checks, requires `v<package.json version>`, downloads the tested artifact, verifies its checksums and attaches the matching JS asset and licensing material. A tag push is a publication trigger: only the release operator may perform it after acceptance. There is no manual release action in this preparation task. GitHub source ZIP/TAR archives are not the built release asset. The default branch is moving development content; a release is a versioned snapshot. Choose the desired version explicitly and refresh frontend caches after switching.

### Verified HACS source behavior

Reviewed 2026-11-10 against [HACS 2.0.5 plugin.py](https://raw.githubusercontent.com/hacs/integration/2.0.5/custom_components/hacs/repositories/plugin.py): `update_filenames` considers the configured filename, looks for a matching release asset when releases/assets exist and content-in-root is false, then checks root and `dist` tree paths. With no release, the default branch must contain the bundle. Both root and dist candidates work in that implementation; this project deliberately uses dist and matching release assets. The [plugin documentation](https://hacs.dev/docs/publish/plugin/) describes the default-branch requirement but lists a different generic location-search order; the exact pinned implementation governs this strategy. The exact method was also executed in isolation with synthetic trees/releases: no-release dist, matching release preference, nonmatching release dist fallback, root fallback and source-only missing artifact all behaved as described. This filename-selection check is not proof of an authenticated installation.

HA 2026.11's built-in Marketplace is a separate current target. Its [official documentation](https://www.home-assistant.io/integrations/marketplace/) describes custom GitHub repositories with hacs.json and Dashboard resources served under `/local/community/`; legacy `/hacsfiles/` links remain compatible after migration. Current HA replaces HACS. Verify actual branch and release installation through both current Marketplace and legacy HA 2026.10.4/HACS 2.0.5 before claiming compatibility. Follow the [README installation steps](../README.md#install), using each install dialog's resource URL.

## CI and pins

`card-ci.yml` runs typecheck, lint, unit tests, a temporary bundle, release-shape checks and schema validation of all YAML card instances. It uploads exactly the JS, license, notices and SHA256SUMS as the release artifact. It does not treat unit fixtures as upstream/hardware proof. Actual NVR/proxy/browser suites require isolated fixtures and remain coordinator acceptance checks.

Node is pinned to **22.22.2**, npm to **11.8.0**, matching the approved package engines/lockfile. Local worker commands used the supplied Node 22.22.2/npm 10.9.7 without installing or changing manifests; CI explicitly installs the approved npm version. GitHub checkout/setup-node/artifact actions are pinned to reviewed commit IDs in the workflows.

The HACS job runs the official **ghcr.io/hacs/action** image, digest `sha256:187499a09c5d41f9f0d42ff80d203ed87b974c028290140913b61e005fb0aab2`, resolved from its primary registry on 2026-11-10. The small local action descriptor freezes that image because even the upstream action at commit `1ebf01c408f29afcb6406bd431bc98fd8cbb15aa` references mutable `:main`. Its `category`, `comment` and `github_token` inputs match the reviewed [upstream action.yml](https://github.com/hacs/action/blob/1ebf01c408f29afcb6406bd431bc98fd8cbb15aa/action.yml); category is **plugin**, comment false, token read-only. No validation checks are ignored. See the [official action instructions](https://hacs.dev/docs/publish/action/). A passing local build does not establish a hosted HACS job passed; inspect the GitHub run after authorized publication. Keep existing Tailor security, CodeQL and community settings intact.

Reproduce locally with existing dependencies:

```sh
LIGHTNVR_BUILD_DIR="$(mktemp -d /tmp/lightnvr-T9-build.XXXXXX)"
export LIGHTNVR_BUILD_DIR
npm run build
npm run check:release
npm run lint
```

The workflow additionally loads the frozen config schema with Node type stripping and validates all four nested card instances from the three YAML files. Inspect the single output module/import graph and the four-file distribution before publishing. No shared `dist` output is needed for these checks.

## Release and catalog checklist

- [ ] Coordinator reviews owned diffs, licensing notices, dependency audit and public-file secret sanitization; private `.execution/` remains ignored/unpublished.
- [ ] Final combined typecheck, lint, unit, real isolated probe/proxy/browser suites and temporary bundle/release check pass with exact version receipts.
- [ ] Publish only the final verified branch bundle; verify fresh manual module load and exactly one resource/card registration.
- [ ] Test authenticated custom-repository install on HA 2026.11.1 Marketplace and HA 2026.10.4/HACS 2.0.5, including no-release `main`, cache refresh and upgrade/reload. An expired or incomplete GitHub device authorization is not a pass.
- [ ] Verify matching tagged release-asset selection and version switching in both paths when release publication is separately authorized; confirm source ZIP is never substituted for JS.
- [x] Record the actual HA 2026.11.1 and 2026.10.4 matrices, 13 checks each: MSE/HLS decoded 1920-pixel frames; injected WebRTC 502 → MSE; independent two-card grid/removal; Sections/reload/native visibility; HA metadata preserving player/authentication/speaker/volume; retry preserving volume; real JPEG snapshot download and editor preview; real editor discovery/selection/grid YAML; injected 403 without fallback; cross-navigation zero microphone acquisition. The [README evidence matrix](../README.md#verified-scope) separates these checks from store installation. Sanitized actual-HA MSE/grid/editor screenshots are included with [provenance](images/README.md).
- [ ] Record device-specific browser/media/talk acceptance. Physical backchannel, Firefox, Safari/native HLS and Companion remain unverified until tested; narrow claims accordingly.
- [ ] Inspect hosted CI/HACS validator outcome and final artifact/checksums; resolve failures before release.
- [ ] Release operator separately authorizes/pushes the matching version tag; inspect attached JS, LICENSE, notices and SHA256SUMS.
- [ ] Re-read current [general publishing requirements](https://hacs.dev/docs/publish/start/) and [default repository submission requirements](https://hacs.dev/docs/publish/include/), plus current Marketplace guidance before any catalog submission. Confirm public repo, description/topics, issues, license, documentation, screenshots and successful custom installation.
- [ ] Submit a separate reviewed default-catalog request only when authorized and eligible. Custom installation must work first. Neither prepared metadata nor HACS validation grants marketplace/default inclusion.

Checked items record only the supplied evidence and do not assert overall T10 completion. Authenticated GitHub Marketplace/HACS installation/upgrade remains untested; the legacy HA 2026.10.4 card matrix has no pass yet. The README’s evidence matrix records these boundaries.
