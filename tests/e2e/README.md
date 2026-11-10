# Actual Home Assistant acceptance

This suite starts no production connection. It uses two disposable, generated services and checks their Podman ownership labels and loopback port bindings before login, dashboard writes or file copies. `setup-ha.mjs` creates a new configuration and generated administrator; no existing HA configuration is accepted. Fixtures and screenshots contain generated credentials and must remain outside Git. Use Linux, Node 22.22.2, npm 11.8.0, Podman, OpenSSL and Chromium. Install the locked dependencies first. These browser/container suites run sequentially.

HA images are large: choose a private local Podman store on a filesystem with sufficient space. `LIGHTNVR_PODMAN_ARGS` accepts a JSON argument array for that local store, for example `["--root", "/private/store", "--runroot", "/private/runtime", "--storage-driver", "overlay"]`. The NVR probe currently uses the default Podman store. No global prune, unrelated service cleanup or production credentials belong in this process.

```sh
node tests/probes/setup-fixture.mjs
# Set the descriptor printed by setup; it contains two generated sources.
export LIGHTNVR_PROBE_FIXTURE=/private/path/from-setup/fixture.json
node tests/e2e/setup-ha.mjs
export LIGHTNVR_HA_FIXTURE=/private/path/from-ha-setup/fixture.json
export LIGHTNVR_CHROMIUM=/usr/bin/chromium-browser
export LIGHTNVR_BUILD_DIR=/private/path/to/temporary-build
export LIGHTNVR_E2E_OUTPUT=/private/path/to/acceptance-results
npm run build
npm run check:release
npm run test:e2e
```

Choose `LIGHTNVR_HA_VERSION=2026.10.4` for the pinned older HA, or the default `2026.11.1`. Both image digests are fixed in `setup-ha.mjs`. `LIGHTNVR_FIXTURE_ROOT` can select the parent directory for the new private HA fixture. Both setup helpers print only descriptor locations, never passwords or tokens. They create internal networks and loopback-only published HTTP ports. There is no broad external container-network access or GitHub account login. The HA helper creates `www` before startup and supplies and explicitly confirms trusted-proxy settings on first boot; on an already migrated HA, changing YAML alone does not update managed HTTP settings.

The matrix copies the locally built bundle into the owned HA config, creates/updates its dedicated `lightnvr-check` dashboard and one module resource, then logs into the actual frontend. It checks decoded MSE and hls.js HLS, real JPEG download and editor preview, independent two-camera grid removal, Sections/reload, native visibility, metadata-only updates, local volume, editor discovery and secret-redacted YAML. A controlled WebRTC HTTP 502 tests fallback to real MSE; an injected 403 tests terminal denial without subsequent media requests. Those injected statuses are explicitly not upstream-role or outage evidence. A cross-navigation counter verifies no microphone acquisition on mount/discovery/fallback. Real WebRTC decode is a separate adapter test; physical backchannel reception is not established here.

A short-lived Node TLS edge and the production routing helper put HA and NVR paths on one browser origin. Chromium trusts only that generated certificate's SPKI for this process. This is not a Traefik test: the separate `npm run test:proxy` suite exercises Traefik. The receipt contains versions and named outcomes, not request headers, URLs, tokens, SDP or raw browser errors. Screenshots contain generated data and remain private until visually reviewed. Browser failures suppress raw authorization redirect details. Missing fixtures produce an explicit skipped test, **not a compatibility pass**; supplying fixtures but omitting the build/output paths fails.

The helper does not authenticate GitHub or prove HACS/Marketplace installation, version switching, releases, hardware talk/PTZ, Safari/native HLS or Companion behavior. Legacy HA core playback and legacy HACS store acceptance are different checks. See [the verification matrix](../../docs/verification.md) for actual results and limitations.

Clean up only the fixtures selected by their descriptors:

```sh
node tests/e2e/cleanup.mjs
```

This removes the matched owned containers and their specifically named networks. It leaves image caches and private receipt/config directories for inspection. Delete those directories separately when no longer needed; never publish them.
