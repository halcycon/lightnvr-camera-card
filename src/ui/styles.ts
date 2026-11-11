import { css } from "lit";
export const viewerStyles = css`
  :host { display:block; min-width:0; height:100%; container-type:inline-size; container-name:lightnvr-card; color:var(--primary-text-color,#222); font-family:var(--ha-font-family,inherit); }
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
  .diagnostics pre { max-height:280px; overflow:auto; font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; }
  .diagnostics { flex-basis:100%; min-width:0; }
  [hidden] { display:none !important; }
  .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }
  .overlay-toolbar { position:absolute; z-index:2; bottom:10px; left:10px; right:10px; display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:2px; padding:4px 6px; color:var(--lightnvr-toolbar-color,#fff); background:var(--lightnvr-toolbar-background,rgba(16,19,23,.8)); border:1px solid rgba(255,255,255,.14); border-radius:var(--lightnvr-toolbar-radius,12px); box-shadow:0 2px 12px rgba(0,0,0,.24); backdrop-filter:blur(10px); }
  .overlay-toolbar button { flex:0 0 44px; width:44px; height:44px; min-height:44px; padding:10px; border:0; border-radius:8px; background:transparent; color:inherit; }
  .overlay-toolbar button:disabled { opacity:.4; }
  .overlay-toolbar button:active:not(:disabled) { background:rgba(255,255,255,.2); }
  .overlay-toolbar button[aria-pressed=true], .overlay-toolbar button[aria-expanded=true] { background:rgba(255,255,255,.15); }
  .overlay-toolbar .hold[aria-pressed=true] { color:#fff; background:#c72d3c; }
  .overlay-toolbar svg { display:block; position:static; width:24px; height:24px; overflow:visible; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
  .toolbar-state { flex:1 1 auto; min-width:0; padding:0 6px; font-size:10px; font-weight:700; letter-spacing:.08em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .toolbar-state.talking { color:#ff7e89; }
  .toolbar-state.pending { color:#ffd58a; }
  .appearance-overlay .body { padding:0 12px; }
  .appearance-overlay .advanced { padding:10px 0 12px; }
  .appearance-overlay .status:not(.sr-only) { padding:8px 0; }
  .appearance-overlay .message, .appearance-overlay [role=alert] { padding:6px 0; }
  @media (hover:hover) and (pointer:fine) { .overlay-toolbar button:hover:not(:disabled) { background:rgba(255,255,255,.15); } }
  @container lightnvr-card (max-width:400px) { .overlay-toolbar { left:6px; right:6px; bottom:6px; padding:3px; gap:0; } .toolbar-state:not(.talking):not(.pending) { display:none; } .toolbar-state:is(.talking,.pending) { position:absolute; bottom:100%; right:4px; padding:4px 8px; background:#351e24; border-radius:6px 6px 0 0; } }
  :host(:fullscreen) { background:var(--card-background-color,#fff); width:100vw; height:100vh; }
  :host(:fullscreen) .viewport { min-height:0; }
  @media (max-width:350px) { .body { padding:6px; } button { padding:7px; } header { padding:8px; } }
`;
