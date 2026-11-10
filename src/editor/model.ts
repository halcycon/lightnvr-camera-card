import { createNvrClient, safeDiagnostic } from '../api';
import { validateConfig, stripHaMetadata, HA_METADATA_KEYS, type CardConfigV1, type CameraSummary, type ClientConfig, type NvrClient, type NvrClientFactory } from '../contracts';
import { cameraConfig, capabilityProblems, configProblem, getStubConfig, migrationPreview, persistentConfig } from './config';

const help: Record<string, string> = {
  auth: 'Check username/password, then test again. Inline MFA requires the lightNVR UI.',
  policy: 'Ask for the required viewer grant in lightNVR; access cannot be bypassed.',
  proxy: 'Check the same-origin proxy routing and cookie scope.',
  network: 'Check the same-origin proxy, HTTPS and browser access to lightNVR.',
  'unsupported-api': 'Check the lightNVR version and that the prefix serves API JSON rather than HTML.',
  'rate-limit': 'Wait for the server retry interval before testing again.',
  configuration: 'Check the connection prefix and close cards using a conflicting identity.',
};
export class EditorModel {
  config = getStubConfig();
  inventory: readonly CameraSummary[] = [];
  capabilities: ClientConfig | undefined;
  status = 'Enter a connection, then test it.';
  error = '';
  busy = false;
  tested = false;
  selected = new Set<string>();
  migration: ReturnType<typeof migrationPreview> | undefined;
  challenge: string | undefined;
  private client: NvrClient | undefined;
  private operation: AbortController | undefined;
  private revision = 0;
  private credentials: { username: string; password: string } | undefined;
  constructor(readonly changed: () => void, readonly emit: (config: CardConfigV1) => void, readonly factory: NvrClientFactory = createNvrClient) {}
  setConfig(input: unknown): void {
    let next: CardConfigV1;
    try { next = validateConfig(input); } catch (e) { throw new Error(configProblem(e)); }
    // HA echoes emitted config; do not invalidate a connection for an identical echo.
    if (JSON.stringify(persistentConfig(this.config)) === JSON.stringify(next)) return;
    if (JSON.stringify(stripHaMetadata(persistentConfig(this.config))) === JSON.stringify(stripHaMetadata(next))) {
      const copy: Record<string, unknown> = { ...this.config };
      for (const key of HA_METADATA_KEYS) {
        if (next[key] === undefined) delete copy[key]; else copy[key] = next[key];
      }
      this.config = validateConfig(copy); this.changed(); return;
    }
    this.cancel(); this.config = next;
    this.credentials = next.username !== undefined || next.password !== undefined ? { username: next.username ?? '', password: next.password ?? '' } : undefined;
    this.inventory = []; this.capabilities = undefined; this.tested = false; this.selected.clear(); this.migration = undefined;
    this.error = ''; this.changed();
  }
  edit(input: unknown, connection = false): boolean {
    this.cancel(); this.error = ''; this.migration = undefined;
    try {
      const next = validateConfig(input);
      this.config = next;
      if (connection) {
        this.credentials = { username: next.username ?? '', password: next.password ?? '' };
        this.tested = false; this.inventory = []; this.capabilities = undefined; this.selected.clear();
      }
      this.emit(persistentConfig(next)); this.changed(); return true;
    } catch (e) { this.error = configProblem(e); this.changed(); return false; }
  }
  cancel(): void {
    this.revision++; this.operation?.abort(); this.operation = undefined;
    this.client?.dispose(); this.client = undefined; this.busy = false; this.challenge = undefined; this.tested = false;
    this.changed();
  }
  private begin(): { revision: number; signal: AbortSignal; client: NvrClient } {
    this.cancel(); this.error = ''; this.busy = true;
    this.operation = new AbortController();
    this.client = this.factory(persistentConfig(this.config));
    return { revision: this.revision, signal: this.operation.signal, client: this.client };
  }
  private failure(e: unknown): void {
    const diagnostic = safeDiagnostic(e);
    this.error = `${diagnostic.message} ${help[diagnostic.code] ?? 'Review lightNVR state and the selected source.'}${diagnostic.retryAfterMs ? ` Retry after ${Math.ceil(diagnostic.retryAfterMs / 1000)} seconds.` : ''}`;
  }
  async testConnection(): Promise<void> {
    this.tested = false; this.inventory = []; this.capabilities = undefined; this.selected.clear();
    let run: ReturnType<EditorModel['begin']> | undefined;
    try {
      run = this.begin(); this.changed();
      const login = await run.client.connect(this.credentials ?? (this.config.username === undefined ? undefined : { username: this.config.username, password: this.config.password ?? '' }), { signal: run.signal });
      if (run.revision !== this.revision) return;
      if (login.kind === 'totp-required') { this.challenge = login.challenge; this.status = 'Enter the one-time code to finish testing.'; return; }
      if (login.kind === 'password-change-required' || login.mustChangePassword) { this.error = 'Change your password in the lightNVR web UI, then test again.'; return; }
      const caps = await run.client.clientConfig({ signal: run.signal });
      if (run.revision !== this.revision) return;
      this.capabilities = caps;
      this.tested = true; this.status = 'Connection tested. Discover authorized cameras next.';
    } catch (e) { if (!run || run.revision === this.revision) this.failure(e); }
    finally { if (!run || run.revision === this.revision) { this.busy = false; this.changed(); } }
  }
  async completeTotp(code: string): Promise<void> {
    const client = this.client, challenge = this.challenge, revision = this.revision, signal = this.operation?.signal;
    if (!client || !challenge || !signal) return;
    this.busy = true; this.error = ''; this.changed();
    try {
      const result = await client.completeTotp(challenge, code, { signal });
      if (revision !== this.revision) return;
      if (result.kind !== 'authenticated' || result.mustChangePassword) { this.error = 'Finish authentication or password change in lightNVR, then test again.'; return; }
      const caps = await client.clientConfig({ signal });
      if (revision !== this.revision) return;
      this.capabilities = caps; this.challenge = undefined; this.tested = true; this.status = 'Connection tested. Discover authorized cameras next.';
    } catch (e) { if (revision === this.revision) this.failure(e); }
    finally { if (revision === this.revision) { this.busy = false; this.changed(); } }
  }
  async discover(): Promise<void> {
    if (!this.tested || !this.client || !this.operation) { this.error = 'Test this connection before discovery.'; this.changed(); return; }
    const revision = this.revision, client = this.client, signal = this.operation.signal;
    this.busy = true; this.error = ''; this.changed();
    try {
      const inventory = await client.discover({ signal });
      if (revision !== this.revision) return;
      this.inventory = inventory; this.status = inventory.length ? `${inventory.length} authorized cameras. Select one to save this card.` : 'No authorized cameras. Check live-view grants or add a camera in lightNVR.';
    } catch (e) { if (revision === this.revision) this.failure(e); }
    finally { if (revision === this.revision) { this.busy = false; this.changed(); } }
  }
  saveCamera(camera: CameraSummary, profile: 'main' | 'sub'): boolean {
    try {
      const config = cameraConfig(this.config, camera, profile);
      const issues = capabilityProblems(config, this.capabilities, camera);
      if (issues.length) throw new Error(issues.join(' '));
      return this.edit(config);
    } catch (e) { this.error = e instanceof Error ? e.message : 'Cannot select this camera.'; this.changed(); return false; }
  }
  previewMigration(text: string): void {
    this.cancel(); this.migration = undefined; this.error = '';
    try { this.migration = migrationPreview(text); } catch { this.error = 'Legacy import rejected. Review supported server/url/mode/media/ui fields, video and transport/audio settings. No changes were saved.'; }
    this.changed();
  }
  applyMigration(): void {
    if (!this.migration) return;
    const next = this.migration.config;
    this.setConfig(next); this.emit(persistentConfig(next)); this.status = 'Migration applied. Test the connection and verify the exact source.'; this.changed();
  }
  dispose(): void { this.cancel(); this.credentials = undefined; this.migration = undefined; }
}
