import { css } from "lit";
export const viewerStyles = css`
  :host { display:block; min-width:0; height:100%; color:var(--primary-text-color,#222); font-family:var(--ha-font-family,inherit); }
  ha-card { display:flex; flex-direction:column; height:100%; overflow:hidden; background:var(--ha-card-background,var(--card-background-color,#fff)); border-radius:var(--ha-card-border-radius,12px); }
  header { padding:12px 16px 8px; font-weight:600; overflow-wrap:anywhere; }
  .viewport { position:relative; overflow:hidden; background:#000; min-height:100px; flex:1 1 auto; }
  video { display:block; width:100%; height:100%; position:absolute; inset:0; }
  .image { position:absolute; inset:0; transform-origin:center; }
  svg { position:absolute; pointer-events:none; overflow:visible; }
  rect { fill:transparent; stroke:var(--primary-color,#03a9f4); stroke-width:2; vector-effect:non-scaling-stroke; }
  text { fill:#fff; paint-order:stroke; stroke:#000; stroke-width:2px; font-size:14px; }
  .body { padding:8px 12px 12px; flex:0 1 auto; min-height:0; overflow-y:auto; }
  .status, .hint { color:var(--secondary-text-color,#555); font-size:.85em; overflow-wrap:anywhere; line-height:1.4; }
  .status { min-height:1.4em; } .row { display:flex; align-items:center; flex-wrap:wrap; gap:6px; }
  button, select, input { font:inherit; color:inherit; background:var(--secondary-background-color,#f4f4f4); border:1px solid var(--divider-color,#ccc); border-radius:6px; box-sizing:border-box; max-width:100%; }
  button, select { min-height:44px; padding:8px 10px; } button { cursor:pointer; touch-action:manipulation; }
  button:disabled { opacity:.55; cursor:default; } button[aria-pressed=true] { background:var(--primary-color,#03a9f4); color:var(--text-primary-color,#fff); }
  :focus-visible { outline:3px solid var(--primary-color,#03a9f4); outline-offset:2px; }
  .hold { touch-action:none; user-select:none; -webkit-user-select:none; }
  label { display:flex; gap:6px; align-items:center; flex-wrap:wrap; font-size:.9em; }
  input { min-height:40px; padding:6px; } input[type=range] { width:110px; padding:0; }
  details { margin-top:8px; } summary { min-height:36px; cursor:pointer; padding-top:8px; }
  .mic { color:var(--error-color,#b00020); font-weight:600; } meter { max-width:100px; }
  a { color:var(--primary-color,#0277bd); display:inline-block; padding:10px 0; }
  .ptz { display:grid; grid-template-columns:repeat(3,minmax(44px,1fr)); gap:4px; max-width:230px; margin:8px 0; }
  .message { overflow-wrap:anywhere; margin:6px 0; } form { display:flex; flex-wrap:wrap; gap:8px; }
  :host(:fullscreen) { background:var(--card-background-color,#fff); width:100vw; height:100vh; }
  :host(:fullscreen) .viewport { min-height:0; }
  @media (max-width:350px) { .body { padding:6px; } button { padding:7px; } header { padding:8px; } }
`;
