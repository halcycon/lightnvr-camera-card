import { LitElement, css, html, nothing } from 'lit';
import { stringify } from 'yaml';
import { createNvrClient, safeDiagnostic, selectSource } from '../api';
import { type CardConfigV1, type CameraSummary, type NvrClientFactory } from '../contracts';
import { capabilityProblems, generateYaml, redactedConfig } from './config';
import { EditorModel } from './model';
export { getStubConfig } from './config';

const controls = ['speaker', 'microphone', 'fullscreen', 'snapshot', 'transport', 'profile', 'zoom', 'ptz', 'daynight', 'recording', 'privacy', 'detection', 'refresh_source', 'timeline'];
const settings: { title: string; fields: [string, string, string[]?][] }[] = [
  { title: 'Playback and fallback', fields: [['transports', 'Ordered transports (comma separated; one forces that mode)'], ['hls.provider', 'HLS provider', ['auto', 'go2rtc', 'native']], ['source', 'Advanced exact source override'], ['go2rtc_path', 'Managed go2rtc path'], ['viewer_url', 'NVR web UI URL (optional; required for links with restricted API proxy)']] },
  { title: 'Timeouts (milliseconds)', fields: [['timeouts.connection_ms', 'Connection timeout (or inherit)'], ['timeouts.ice_grace_ms', 'ICE recovery grace'], ['timeouts.webrtc_ms', 'WebRTC override'], ['timeouts.mse_ms', 'MSE override'], ['timeouts.hls_ms', 'HLS override']] },
  { title: 'Retry', fields: [['retry.base_ms', 'Base milliseconds'], ['retry.cap_ms', 'Cap milliseconds'], ['retry.attempts', 'Attempts'], ['retry.jitter', 'Jitter (0–1)']] },
  { title: 'Audio and talk', fields: [['audio.enabled', 'Audio enabled'], ['audio.listen', 'Request listening'], ['audio.muted', 'Start muted'], ['audio.microphone', 'Allow microphone control'], ['audio.talk_mode', 'Talk mode', ['ptt', 'toggle']], ['audio.volume', 'Volume (0–1)']] },
  { title: 'Controls (default follows viewer capability)', fields: controls.map(name => [`controls.${name}`, name.replaceAll('_', ' '), ['default', 'true', 'false']]) },
  { title: 'Layout and visibility', fields: [['layout.aspect_ratio', 'Aspect ratio (number)'], ['layout.object_fit', 'Video fit', ['contain', 'cover']], ['layout.fullscreen_main', 'Use main in fullscreen'], ['playback_visibility.hidden', 'When document hidden', ['pause', 'continue']], ['playback_visibility.offscreen', 'When offscreen', ['pause', 'continue']]] },
];
const connectionFields = new Set(['server', 'username', 'password', 'auth', 'credential_storage', 'go2rtc_path']);
const optionalNumbers = new Set(['timeouts.webrtc_ms', 'timeouts.mse_ms', 'timeouts.hls_ms']);
function valueAt(config: CardConfigV1, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], config);
}

export class LightNvrCardEditor extends LitElement {
  static styles = css`
    :host { display:block; color:var(--primary-text-color,#222); font:inherit; }
    fieldset { border:1px solid var(--divider-color,#ccc); border-radius:8px; padding:16px; margin:12px 0; min-width:0; }
    legend, summary { font-weight:600; } details { margin:12px 0; } summary { cursor:pointer; padding:8px 0; }
    label { display:flex; flex-direction:column; gap:5px; margin:10px 0; }
    input, select, textarea, button { font:inherit; color:inherit; background:var(--card-background-color,#fff); border:1px solid var(--divider-color,#aaa); border-radius:5px; padding:9px; box-sizing:border-box; }
    input, select, textarea { width:100%; } input[type=checkbox] { width:auto; }
    button { cursor:pointer; margin:4px; } button:disabled { opacity:.55; cursor:default; }
    :focus-visible { outline:2px solid var(--primary-color,#03a9f4); outline-offset:2px; }
    .row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; } .row label { flex:1; min-width:130px; }
    .inventory { max-height:340px; overflow:auto; } .camera { border-top:1px solid var(--divider-color,#ddd); padding:8px 0; }
    .camera label { display:inline-flex; flex-direction:row; } .hint { color:var(--secondary-text-color,#555); font-size:.9em; line-height:1.5; }
    [role=alert] { color:var(--error-color,#b00020); overflow-wrap:anywhere; } pre { white-space:pre-wrap; overflow-wrap:anywhere; } img { max-width:100%; }
  `;
  // HA can assign hass; this editor needs no HA state or entity subscriptions.
  hass: unknown;
  private factory: NvrClientFactory = createNvrClient;
  readonly model = new EditorModel(() => this.requestUpdate(), config => {
    this.clearPreview(); this.yaml = '';
    this.dispatchEvent(new CustomEvent('config-changed', { detail: { config }, bubbles: true, composed: true }));
  }, config => this.factory(config));
  private search = '';
  private profile: 'main' | 'sub' = 'main';
  private legacy = '';
  private yaml = '';
  private otp = '';
  private previewUrl = '';
  private previewRevision = 0;
  private previewAbort: AbortController | undefined;
  private previewDispose: (() => void) | undefined;
  private previewLabel = '';
  /** Injectable only for isolated host/tests; no independent fetch implementation. */
  set clientFactory(factory: NvrClientFactory) { this.model.cancel(); this.factory = factory; }
  setConfig(config: unknown): void { this.clearPreview(); this.yaml = ''; this.model.setConfig(config); this.profile = this.model.config.profile; }
  disconnectedCallback(): void { this.clearPreview(); this.model.dispose(); super.disconnectedCallback(); }
  private clearPreview(): void {
    this.previewRevision++; this.previewAbort?.abort(); this.previewAbort = undefined;
    this.previewDispose?.(); this.previewDispose = undefined;
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = ''; this.previewLabel = ''; this.requestUpdate();
  }
  private updateField(path: string, raw: string | boolean): void {
    this.clearPreview(); this.yaml = '';
    const next = structuredClone(this.model.config) as unknown as Record<string, unknown>;
    const parts = path.split('.'); const key = parts.pop()!;
    let owner = next;
    for (const part of parts) owner = owner[part] as Record<string, unknown>;
    const current = valueAt(this.model.config, path);
    if (raw === '' && (optionalNumbers.has(path) || ['source', 'viewer_url', 'username', 'password', 'title'].includes(path))) delete owner[key];
    else if (path.startsWith('controls.')) { if (raw === 'default') delete owner[key]; else owner[key] = raw === 'true'; }
    else if (path === 'transports') owner[key] = String(raw).split(',').map(s => s.trim());
    else if (typeof current === 'number' || optionalNumbers.has(path) || path === 'timeouts.connection_ms') owner[key] = raw === 'inherit' ? raw : Number(raw);
    else owner[key] = raw;
    this.model.edit(next, connectionFields.has(path));
  }
  private field(path: string, label: string, choices?: string[]) {
    const value = valueAt(this.model.config, path);
    if (choices) return html`<label>${label}<select .value=${String(value ?? (path.startsWith('controls.') ? 'default' : ''))} @change=${(e: Event) => this.updateField(path, (e.target as HTMLSelectElement).value)}>${choices.map(c => html`<option value=${c}>${c}</option>`)}</select></label>`;
    if (typeof value === 'boolean') return html`<label class="row"><span>${label}</span><input type="checkbox" .checked=${value} @change=${(e: Event) => this.updateField(path, (e.target as HTMLInputElement).checked)}></label>`;
    return html`<label>${label}<input type=${path === 'password' ? 'password' : 'text'} autocomplete=${path === 'password' ? 'new-password' : 'off'} .value=${Array.isArray(value) ? value.join(', ') : String(value ?? '')} @change=${(e: Event) => this.updateField(path, (e.target as HTMLInputElement).value)}></label>`;
  }
  private available(camera: CameraSummary): boolean {
    return camera.status !== 'disabled' && camera.privacy !== true && camera.capabilities['live.view'] !== 'denied' && (this.profile === 'main' || !!camera.sources.sub);
  }
  private async preview(camera: CameraSummary): Promise<void> {
    this.clearPreview(); this.model.error = '';
    if (!this.available(camera) || camera.capabilities.snapshot === 'denied') { this.model.error = 'Snapshot preview unavailable: review privacy, live/snapshot grants or substream availability in lightNVR.'; this.requestUpdate(); return; }
    const revision = this.previewRevision;
    const abort = new AbortController(); this.previewAbort = abort;
    const config = { ...this.model.config, stream: camera.name, profile: this.profile };
    delete config.source; delete config.camera_uuid;
    if (camera.uuid) config.camera_uuid = camera.uuid;
    let client: ReturnType<NvrClientFactory> | undefined;
    try {
      client = this.factory(config); this.previewDispose = () => client?.dispose();
      const source = selectSource(config, this.model.inventory);
      const url = new URL(client.mediaUrls(source, false).snapshot);
      const base = new URL(client.profile.baseUrl);
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error();
      const response = await client.authorizedFetch(url.pathname.slice(base.pathname.length) + url.search, { signal: abort.signal });
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      if (!response.headers.get('content-type')?.startsWith('image/')) { await response.body?.cancel(); throw new Error(); }
      const blob = await response.blob();
      if (revision !== this.previewRevision) return;
      this.previewUrl = URL.createObjectURL(blob); this.previewLabel = `${camera.name} — ${this.profile} snapshot`; this.requestUpdate();
    } catch (e) { if (revision === this.previewRevision) { this.model.error = `${safeDiagnostic(e).message} Snapshot preview requires an authorized image endpoint and a tested cookie session.`; this.requestUpdate(); } }
    finally { client?.dispose(); }
  }
  private generate(mode: 'grid' | 'cards'): void {
    try {
      const cameras = this.model.inventory.filter(c => this.model.selected.has(c.name));
      for (const camera of cameras) {
        const c = { ...this.model.config, stream: camera.name, profile: this.profile }; delete c.source;
        const problems = capabilityProblems(c, this.model.capabilities, camera);
        if (problems.length) throw new Error(problems.join(' '));
      }
      this.yaml = generateYaml(this.model.config, cameras, this.profile, mode); this.model.error = '';
    } catch (e) { this.yaml = ''; this.model.error = e instanceof Error ? e.message : 'Cannot generate YAML.'; }
    this.requestUpdate();
  }
  protected render() {
    const m = this.model;
    const cameras = m.inventory.filter(c => c.name.toLocaleLowerCase().includes(this.search.toLocaleLowerCase()));
    const currentCamera = m.inventory.find(c => c.name === m.config.stream);
    const problems = capabilityProblems(m.config, m.capabilities, currentCamera);
    return html`
      <p class="hint">Full browser playback requires a same-origin proxy prefix on the Home Assistant origin, routed to lightNVR with isolated session cookies and WebSocket support. Remote HTTPS alone does not provide this. Never expose raw go2rtc.</p>
      <fieldset><legend>1. Connect</legend>
        ${this.field('server', 'lightNVR root or same-origin prefix')}
        ${this.field('auth', 'Authentication', ['session', 'basic'])}
        <p class="hint">Basic supports verified fetch routes only; browser WebSockets and native HLS cannot carry its Authorization header. Use the proxy with a cookie session for full support.</p>
        ${this.field('credential_storage', 'Credential storage', ['dashboard', 'session'])}
        <p class="hint">Dashboard credentials are readable by dashboard configuration readers. Session credentials stay in this editor’s memory and are omitted from saved configuration; reauthentication may be needed in the viewer.</p>
        ${this.field('username', 'Username')}${this.field('password', 'Password')}
        <button ?disabled=${m.busy} @click=${() => { this.clearPreview(); void m.testConnection(); }}>2. Test connection</button>
        <button ?disabled=${!m.busy && !m.challenge} @click=${() => { this.clearPreview(); m.cancel(); m.status = 'Cancelled. Test the connection to continue.'; }}>Cancel</button>
        ${m.challenge ? html`<label>One-time code<input inputmode="numeric" autocomplete="one-time-code" type="password" .value=${this.otp} @input=${(e: Event) => { this.otp = (e.target as HTMLInputElement).value; }}></label><button ?disabled=${m.busy} @click=${() => { const code = this.otp; this.otp = ''; void m.completeTotp(code); }}>Complete authentication</button>` : nothing}
        <button ?disabled=${m.busy || !m.tested} @click=${() => m.discover()}>3. Discover cameras</button>
      </fieldset>
      <p role="status" aria-live="polite">${m.busy ? 'Working… ' : ''}${m.status}</p>
      ${m.error ? html`<p role="alert">${m.error}</p>` : nothing}
      ${problems.map(p => html`<p role="alert">${p}</p>`)}
      <fieldset><legend>4. Select camera</legend>
        ${this.field('stream', 'Current camera / manual exact selector')}${this.field('title', 'Card title (optional)')}
        <p class="hint">Manual exact sources keep their exact name; without a discovered canonical camera, controls and native HLS are unavailable. Unknown grants remain subject to server authorization.</p>
        <label>Profile for selection and preview<select .value=${this.profile} @change=${(e: Event) => { this.clearPreview(); this.yaml = ''; this.profile = (e.target as HTMLSelectElement).value as 'main' | 'sub'; this.requestUpdate(); }}><option value="main">Main</option><option value="sub">Sub (requires managed substream)</option></select></label>
        <label>Search ${m.inventory.length} cameras<input type="search" .value=${this.search} @input=${(e: Event) => { this.search = (e.target as HTMLInputElement).value; this.requestUpdate(); }}></label>
        <div class="inventory">${cameras.map(camera => html`<div class="camera">
          <label><input type="checkbox" aria-label=${`Include ${camera.name} in YAML`} ?disabled=${!this.available(camera)} .checked=${m.selected.has(camera.name)} @change=${(e: Event) => { if ((e.target as HTMLInputElement).checked) m.selected.add(camera.name); else m.selected.delete(camera.name); this.yaml = ''; this.requestUpdate(); }}>${camera.name}</label>
          <span class="hint">${camera.status}; privacy ${String(camera.privacy)}; sub ${camera.sources.sub ? 'available' : 'unavailable'}; talk ${camera.backchannel}; live ${camera.capabilities['live.view'] ?? 'unknown'}</span>
          <button ?disabled=${!this.available(camera)} @click=${() => { if (m.saveCamera(camera, this.profile)) this.profile = m.config.profile; }}>Use for this card</button>
          <button ?disabled=${!this.available(camera) || camera.capabilities.snapshot === 'denied'} @click=${() => this.preview(camera)}>Preview ${this.profile} snapshot</button>
        </div>`)}</div>
        <p class="hint">Disabled/private cameras cannot be selected. Offline cameras may recover. Snapshot previews are read-only images: no microphone, player, PTZ, recording or privacy mutations.</p>
        ${this.previewUrl ? html`<img src=${this.previewUrl} alt=${this.previewLabel}><button @click=${() => this.clearPreview()}>Close preview</button>` : nothing}
      </fieldset>
      ${settings.map(group => html`<details><summary>${group.title}</summary>${group.fields.map(([path, label, choices]) => this.field(path, label, choices))}</details>`)}
      <p class="hint">Microphone requires a secure Home Assistant document (HTTPS or localhost), permission, WebRTC and an authorized camera backchannel. Enabling the control never acquires a microphone here. Disable listen and microphone before disabling audio. Native HLS requires the exact main camera and listening enabled. Server denials never trigger another route.</p>
      <fieldset><legend>Multiple cameras → YAML</legend>
        <p class="hint">${m.selected.size} selected. Explicit generation omits login credentials and preserves ICE routing with placeholders for TURN secrets. The output needs review: restore required credentials and TURN placeholders before playback can work. UI-managed dashboards do not promise !secret support. Separate cards are a YAML list; a grid is one native HA card. Copy into the dashboard yourself.</p>
        <button @click=${() => this.generate('cards')}>Generate separate cards</button><button @click=${() => this.generate('grid')}>Generate native grid</button>
        ${this.yaml ? html`<label>Generated YAML<textarea readonly rows="14" .value=${this.yaml}></textarea></label>` : nothing}
      </fieldset>
      <details><summary>Import legacy YAML with migration preview</summary>
        <p class="hint">Paste the old server/url/mode/media/ui card. Input is masked; preview removes URL userinfo and redacts credentials. Nothing is applied until you choose Apply migration. Unsupported fields are rejected.</p>
        <label>Legacy YAML (masked)<input type="password" autocomplete="off" .value=${this.legacy} @input=${(e: Event) => { this.legacy = (e.target as HTMLInputElement).value; m.migration = undefined; }} @paste=${(e: ClipboardEvent) => { const text = e.clipboardData?.getData('text/plain'); if (text !== undefined) { e.preventDefault(); this.legacy = text; m.migration = undefined; this.requestUpdate(); } }}></label>
        <button @click=${() => { m.previewMigration(this.legacy); this.legacy = ''; }}>Preview migration</button>
        ${m.migration ? html`<pre>${stringify(redactedConfig(m.migration.config))}</pre><p class="hint">${m.migration.warnings.join(' ')}</p><button @click=${() => m.applyMigration()}>Apply migration</button>` : nothing}
      </details>`;
  }
}
if (!customElements.get('lightnvr-camera-card-editor')) customElements.define('lightnvr-camera-card-editor', LightNvrCardEditor);
export function createEditorElement(): LightNvrCardEditor { return document.createElement('lightnvr-camera-card-editor') as LightNvrCardEditor; }
