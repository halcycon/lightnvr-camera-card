import { svg } from "lit";

export type ToolbarIcon =
  | "retry"
  | "speaker"
  | "muted"
  | "microphone"
  | "fullscreen"
  | "snapshot"
  | "settings";
// Small authored stroke icons; no external icon service or runtime dependency.
const paths: Record<ToolbarIcon, string> = {
  retry: "M20 8V3l-3 3a8 8 0 1 0 2 10M20 8h-5",
  speaker: "M11 4 6 8H3v8h3l5 4V4Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14",
  muted: "M11 4 6 8H3v8h3l5 4V4Zm5 5 5 6m0-6-5 6",
  microphone:
    "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Zm-3 6v1a6 6 0 0 0 12 0v-1m-6 7v4m-3 0h6",
  fullscreen: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5",
  snapshot: "M3 7h4l2-3h6l2 3h4v13H3V7Zm13 6a4 4 0 1 0-8 0 4 4 0 0 0 8 0",
  settings: "M4 3v4m0 4v10M2 7h4m6-4v10m0 4v4m-2-8h4m6-10v4m0 4v10m-2-14h4",
};
export function toolbarIcon(name: ToolbarIcon) {
  return svg`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d=${paths[name]} /></svg>`;
}
