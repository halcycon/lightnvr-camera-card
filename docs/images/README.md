# Screenshot provenance

These are actual Home Assistant **2026.11.1 Container** screenshots in **Chromium 156**, supplied and visually reviewed as safe by the coordinator on **2026-11-10**, then visually inspected before copying into the public documentation. They use an isolated fixture with generated media and camera names, with no production hosts, camera scenes, credentials, address bar, SDP or configuration secrets shown. They are not AI-generated UI mockups.

| Image | What it shows |
| --- | --- |
| [ha-generated-mse.png](ha-generated-mse.png) | One card playing a generated 1920-pixel test pattern through MSE. |
| [ha-generated-grid.png](ha-generated-grid.png) | An actual HA native grid containing two cards, both showing generated media with playing/MSE status. |
| [ha-generated-editor.png](ha-generated-editor.png) | The actual HA card editor after discovery of two generated fixture cameras, with both selected and the multi-camera YAML generation controls/output visible. The credential section is outside the screenshot. |

The coordinator’s expanded 11-case actual-HA matrix separately established decoded MSE/HLS frames, fallback/denial behavior, independent card removal, Sections/reload/native visibility, metadata and volume preservation, real editor discovery/selection/grid YAML, and no microphone acquisition across navigation. A still image alone does not prove these behaviors. See the [evidence matrix](../../README.md#verified-scope).

The disabled talk controls do not establish physical camera backchannel support. None of these images proves authenticated GitHub Marketplace/HACS installation or upgrade, legacy HA 2026.10.4 card acceptance, Safari/Companion support or physical talk.
