# HA layout metadata compatibility

The former strict-schema rejection and visibility naming collision are resolved
in code through coordinator-owned shared contracts, T6 and T8 changes, and T7's
metadata-aware card identity. Actual installed HA browser acceptance remains T10.
No shared contracts/editor/controller files were changed by this worker.

## HA boundary verified from source

Official frontend `dev` source reviewed 2026-11-10:

- [HuiCard](https://github.com/home-assistant/frontend/blob/dev/src/panels/lovelace/cards/hui-card.ts), lines 82–120 merges default element sizing and configuration sizing; lines 122–127 passes the complete config to custom `setConfig` on updates.
- [Element creation](https://github.com/home-assistant/frontend/blob/dev/src/panels/lovelace/create-element/create-element-base.ts), lines 137–146 passes the complete config at creation.
- [Layout editor](https://github.com/home-assistant/frontend/blob/dev/src/panels/lovelace/editor/card-editor/hui-card-layout-editor.ts), lines 299–305 and 374–394 writes `grid_options` into the original config and removes deprecated `layout_options`.
- [HA config type](https://github.com/home-assistant/frontend/blob/dev/src/data/lovelace/config/card.ts), lines 5–16 lists grid/view/legacy layout metadata, `index`, `view_index`, `disabled` and native `visibility` conditions.

## Supported configuration and lifecycle

The coordinator's shared validator preserves optional `grid_options`: numeric or
`full` columns, numeric or `auto` rows and numeric min/max bounds. There is no
12-column cap: HA can span multiple sections. Legacy `layout_options`, opaque
`view_layout`, native `visibility` condition arrays, `index`, `view_index` and
`disabled` are retained. These are the exported `HA_METADATA_KEYS`; HA owns their
layout/condition meaning and they never select media/control URLs. Editor events
and config/YAML round trips preserve them.

`playback_visibility: {hidden, offscreen}` is the canonical playback policy and
is not HA metadata. A legacy object at `visibility` is normalized to that policy
only if the new field is absent. An old object together with an explicit new
policy is rejected as ambiguous. Native HA conditions and the canonical playback
policy can coexist without collision.

The card retains the complete validated received config separately from its
local profile/volume choices. Its `setConfig` compares configurations through
shared `stripHaMetadata`. Layout-only changes replace the stored HA metadata and
request a render, preserving the existing video, API client, pending login,
controller, microphone gesture and active talk. Removed metadata stays removed.
Actual playback-policy/source/credential changes retain the normal cancellation
and restart path. The coordinator applied the same identity boundary in T6, and
metadata-only editor updates preserve T8's tested connection/session state.

Fullscreen main/sub overrides and local volume remain independent of the received
HA baseline. Metadata changes during main fullscreen do not recreate the player,
and the current metadata is retained when restoring the selected profile. The
card's `getGridOptions` continues to return defaults; HA applies configured sizes.
HA evaluating conditions to hide/remove a card still reaches the card's existing
intersection/visibility/disconnect cleanup; merely changing a condition definition
does not itself cancel an active gesture before HA changes visibility.

## Evidence and remaining acceptance

`tests/unit/card/ha-metadata.test.ts` now tests acceptance and preservation through
shared validation, card storage, initial playback configuration and editor events.
It covers layout-only updates without media/auth/mic teardown, active toggle talk,
pending login, metadata removal/recreation, fullscreen restoration, local volume,
legacy normalization and ambiguous-policy rejection. Rejection-reproduction tests
were replaced with these acceptance checks. Other card tests exercise actual T6
controller visibility behavior with a simulated media adapter.

These generated happy-dom/unit fixtures establish the code boundary; they do not
establish installed HA Sections resizing, native grid/stack/panel rendering,
condition evaluation, editor save/reload or physical camera/audio behavior. T10
must perform those browser/device checks on the coordinator's combined build.
