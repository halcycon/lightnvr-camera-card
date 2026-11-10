// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parse } from 'yaml';
import { validateConfig, NvrError, type CameraSummary, type ClientConfig, type NvrClient } from '../../../src/contracts';
import { cameraConfig, capabilityProblems, configProblem, generateYaml, getStubConfig, migrationPreview, parseConfigYaml, persistentConfig, redactedConfig } from '../../../src/editor/config';
import { EditorModel } from '../../../src/editor/model';
import { createEditorElement, LightNvrCardEditor } from '../../../src/editor';

const camera = (name = 'camera_1', extra: Partial<CameraSummary> = {}): CameraSummary => ({ name, sources: { main: name, sub: `${name}_sub` }, status: 'online', privacy: false, capabilities: { 'live.view': 'allowed' }, backchannel: 'unknown', ptz: 'unknown', ...extra });
const caps: ClientConfig = { go2rtc: 'allowed', forceNativeHls: false, audioDisabled: false, transports: { webrtc: 'allowed', mse: 'allowed', hls: 'allowed' } };
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function fixture(inventory: readonly CameraSummary[] = [camera()]) {
  const client = { connect: vi.fn().mockResolvedValue({ kind: 'authenticated', mustChangePassword: false }), clientConfig: vi.fn().mockResolvedValue(caps), discover: vi.fn().mockResolvedValue(inventory), dispose: vi.fn(), completeTotp: vi.fn().mockResolvedValue({ kind: 'authenticated', mustChangePassword: false }), control: vi.fn(), authorizedFetch: vi.fn() } as unknown as NvrClient;
  const emit = vi.fn(); const model = new EditorModel(vi.fn(), emit, () => client);
  return { model, client, emit };
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('configuration and YAML', () => {
  it('provides independent schema-valid defaults', () => { const a = getStubConfig(); a.retry.attempts = 0; expect(getStubConfig().retry.attempts).toBe(5); expect(validateConfig(getStubConfig())).toEqual(getStubConfig()); });
  it('migrates exact front_door_sub without inferring another suffix or registering the old card', () => {
    const preview = migrationPreview('type: custom:webrtc-camera\nserver: https://viewer:p%40ss@example.test/go2rtc/\nurl: front_door_sub\nmode: webrtc\nmedia: video,audio,microphone\nui: false');
    expect(preview.config).toMatchObject({ server: 'https://example.test/', stream: 'front_door_sub', source: 'front_door_sub', profile: 'main', username: 'viewer', password: 'p@ss', transports: ['webrtc'] });
    expect(preview.config.controls.ptz).toBe(false); expect(customElements.get('webrtc-camera')).toBeUndefined();
    expect(JSON.stringify(redactedConfig(preview.config))).not.toContain('p@ss');
  });
  it.each(['unexpected: true', 'media: {video: false}', 'mode: hls\nmedia: video,microphone'])('rejects unsupported legacy shapes and incompatible intent: %s', suffix => {
    expect(() => migrationPreview(`server: https://example.test/go2rtc/\nurl: front_door_sub\n${suffix}`)).toThrow('Legacy import rejected');
  });
  it.each(['a: 1\na: 2', 'server: !secret password', 'a: &a [one]\nb: *a'])('rejects duplicate keys, tags and aliases', text => expect(() => parseConfigYaml(text)).toThrow());
  it('removes session login credentials from persistence', () => {
    const c = validateConfig({ ...getStubConfig(), credential_storage: 'session', username: 'viewer', password: 'private' });
    expect(persistentConfig(c)).not.toHaveProperty('password'); expect(persistentConfig(c)).not.toHaveProperty('username'); expect(c.password).toBe('private');
  });
  it('redacts login and ICE credentials in migration display', () => {
    const c = validateConfig({ ...getStubConfig(), username: 'viewer', password: 'private', ice_servers: [{ urls: 'turn:example.test', username: 'turn-user', credential: 'turn-secret' }] });
    const shown = JSON.stringify(redactedConfig(c)); for (const secret of ['viewer', 'private', 'turn-user', 'turn-secret']) expect(shown).not.toContain(secret);
  });
  it('distinguishes literal suffix cameras from managed substreams', () => {
    expect(cameraConfig(getStubConfig(), camera('front_door_sub'), 'main')).toMatchObject({ stream: 'front_door_sub', profile: 'main' });
    expect(cameraConfig({ ...getStubConfig(), source: 'old', camera_uuid: 'old' }, camera('front_door'), 'sub')).toMatchObject({ stream: 'front_door', profile: 'sub' });
    expect(cameraConfig(getStubConfig(), camera(), 'sub')).not.toHaveProperty('source');
  });
  it.each([{ status: 'disabled' as const }, { privacy: true }, { capabilities: { 'live.view': 'denied' as const } }])('blocks unavailable cameras', extra => expect(() => cameraConfig(getStubConfig(), camera('private', extra), 'main')).toThrow());
  it('rejects missing substreams', () => expect(() => cameraConfig(getStubConfig(), camera('main', { sources: { main: 'main' } }), 'sub')).toThrow('No managed substream'));
  it.each(['grid', 'cards'] as const)('parses generated %s with all cards validated, advanced fields retained, secrets excluded', mode => {
    const c = validateConfig({ ...getStubConfig(), username: 'viewer', password: 'secret', retry: { attempts: 7 }, visibility: { hidden: 'continue' }, ice_servers: [{ urls: 'turn:example.test', credential: 'secret' }] });
    const yaml = generateYaml(c, [camera('one'), camera('two')], 'sub', mode);
    const parsed = parse(yaml); const cards = mode === 'grid' ? parsed.cards : parsed;
    expect(cards).toHaveLength(2); for (const card of cards) { expect(validateConfig(card)).toMatchObject({ profile: 'sub', retry: { attempts: 7 }, visibility: { hidden: 'continue' } }); expect(card).not.toHaveProperty('password'); expect(card.ice_servers).toEqual([{ urls: 'turn:example.test', credential: 'REPLACE_WITH_TURN_CREDENTIAL' }]); }
    expect(JSON.stringify(parsed)).not.toContain('secret'); if (mode === 'grid') expect(parsed).toMatchObject({ type: 'grid', columns: 2, square: false });
  });
  it('rejects empty selection and invalid grid size', () => { expect(() => generateYaml(getStubConfig(), [], 'main', 'grid')).toThrow(); expect(() => generateYaml(getStubConfig(), [camera()], 'main', 'grid', 0)).toThrow(); });
  it.each([['webrtc'], ['mse'], ['hls'], ['webrtc', 'hls']])('validates forced or ordered transport %s', (...transports) => expect(validateConfig({ ...getStubConfig(), transports }).transports).toEqual(transports));
  it.each([{ transports: [] }, { transports: ['webrtc', 'webrtc'] }, { transports: ['other'] }])('rejects invalid transport list %j', ({ transports }) => expect(() => validateConfig({ ...getStubConfig(), transports })).toThrow());
  it('rejects microphone without WebRTC and inverted retries', () => {
    expect(() => validateConfig({ ...getStubConfig(), transports: ['hls'], audio: { microphone: true } })).toThrow();
    expect(() => validateConfig({ ...getStubConfig(), retry: { base_ms: 30000, cap_ms: 1000 } })).toThrow();
  });
  it('identifies server-forced HLS, disabled transport/audio, unsupported native source and talk', () => {
    const disabled: ClientConfig = { ...caps, forceNativeHls: true, go2rtc: 'denied', audioDisabled: true, transports: { ...caps.transports, webrtc: 'denied' } };
    const config = validateConfig({ ...getStubConfig(), profile: 'sub', audio: { microphone: true } });
    const problems = capabilityProblems(config, disabled, camera('one', { backchannel: 'denied', capabilities: { 'audio.listen': 'denied', 'audio.talk': 'denied' } })).join(' ');
    for (const word of ['disabled', 'HLS only', 'exact main', 'backchannel', 'Listening is denied', 'Talk is denied']) expect(problems).toContain(word);
  });
  it('force-native HLS changes the HLS provider without forbidding WebRTC/MSE', () => {
    const force = { ...caps, forceNativeHls: true as const };
    expect(capabilityProblems(getStubConfig(), force, camera())).toEqual([]);
    expect(capabilityProblems(validateConfig({ ...getStubConfig(), transports: ['webrtc', 'mse'], hls: { provider: 'go2rtc' } }), force, camera())).toEqual([]);
    expect(capabilityProblems(validateConfig({ ...getStubConfig(), hls: { provider: 'go2rtc' } }), force, camera()).join(' ')).toContain('Choose native or auto');
    expect(capabilityProblems(getStubConfig(), { ...force, go2rtc: 'denied' }, camera()).join(' ')).toContain('HLS only');
  });
  it.each(['grid', 'cards'] as const)('preserves nonsecret ICE routing in %s and flags all secret placeholders', mode => {
    const base = validateConfig({ ...getStubConfig(), ice_servers: [
      { urls: 'stun:example.test:3478' },
      { urls: ['turn:example.test:3478?transport=udp', 'turns:example.test:5349?transport=tcp'], username: 'private-user', credential: 'private-pass' },
      { urls: 'turn:inline:private@example.test:3478' },
    ] });
    const yaml = generateYaml(base, [camera()], 'main', mode);
    const output = parse(yaml); const card = mode === 'grid' ? output.cards[0] : output[0];
    expect(card.ice_servers).toEqual([
      { urls: 'stun:example.test:3478' },
      { urls: ['turn:example.test:3478?transport=udp', 'turns:example.test:5349?transport=tcp'], username: 'REPLACE_WITH_TURN_USERNAME', credential: 'REPLACE_WITH_TURN_CREDENTIAL' },
      { urls: 'turn:REDACTED@example.test:3478' },
    ]);
    expect(yaml).toContain('REVIEW BEFORE USE'); expect(yaml).toContain('playback may fail');
    for (const secret of ['private-user', 'private-pass', 'inline:private']) expect(yaml).not.toContain(secret);
    expect(validateConfig(card).ice_servers).toHaveLength(3);
  });
  it('rejects unknown options with a safe useful field path', () => {
    try { validateConfig({ ...getStubConfig(), retry: { private_secret: 'DO_NOT_DISPLAY' } }); } catch (e) { expect(configProblem(e)).toContain('retry: unsupported option'); expect(configProblem(e)).not.toContain('DO_NOT_DISPLAY'); }
  });
});

describe('connection/discovery lifecycle', () => {
  it('tests then discovers more than 100 authorized cameras and saves one', async () => {
    const { model, emit } = fixture(Array.from({ length: 251 }, (_, i) => camera(`camera_${i}`)));
    await model.testConnection(); expect(model.tested).toBe(true); await model.discover(); expect(model.inventory).toHaveLength(251);
    expect(model.saveCamera(model.inventory[250]!, 'sub')).toBe(true); expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ stream: 'camera_250', profile: 'sub', retry: expect.any(Object), timeouts: expect.any(Object), audio: expect.any(Object), controls: expect.any(Object), layout: expect.any(Object) }));
  });
  it('distinguishes an empty authorized inventory', async () => { const { model } = fixture([]); await model.testConnection(); await model.discover(); expect(model.error).toBe(''); expect(model.status).toContain('No authorized cameras'); });
  it('redacts bad credentials/raw upstream errors and provides an action', async () => {
    const { model, client } = fixture(); vi.mocked(client.connect).mockRejectedValue(new NvrError({ code: 'auth', message: 'RAW_PASSWORD https://user:secret@example.test' }));
    await model.testConnection(); expect(model.error).toContain('Check username/password'); expect(model.error).not.toContain('RAW_PASSWORD'); expect(model.error).not.toContain('secret'); expect(model.tested).toBe(false);
  });
  it('keeps new edits/inventory safe from late discovery after cancellation', async () => {
    const { model, client } = fixture(); await model.testConnection(); const pending = deferred<readonly CameraSummary[]>(); vi.mocked(client.discover).mockReturnValue(pending.promise);
    const task = model.discover(); const signal = vi.mocked(client.discover).mock.calls[0]![0]!.signal!;
    model.edit({ ...model.config, title: 'Later edit' }); expect(signal.aborted).toBe(true); pending.resolve([camera('stale')]); await task;
    expect(model.inventory).toHaveLength(0); expect(model.config.title).toBe('Later edit'); expect(client.dispose).toHaveBeenCalled();
  });
  it('late capabilities cannot clear a newer test result', async () => {
    const { model, client } = fixture(); const old = deferred<ClientConfig>(); vi.mocked(client.clientConfig).mockReturnValueOnce(old.promise).mockResolvedValueOnce(caps);
    const task = model.testConnection(); await Promise.resolve(); model.cancel(); await model.testConnection(); old.resolve({ ...caps, audioDisabled: true }); await task; expect(model.capabilities).toEqual(caps);
  });
  it('completes interactive TOTP without persisting code/challenge', async () => {
    const { model, client, emit } = fixture(); vi.mocked(client.connect).mockResolvedValue({ kind: 'totp-required', challenge: 'private-challenge' });
    await model.testConnection(); expect(model.challenge).toBe('private-challenge'); await model.completeTotp('123456'); expect(model.tested).toBe(true); expect(model.challenge).toBeUndefined(); expect(emit).not.toHaveBeenCalled();
  });
  it.each([{ kind: 'password-change-required' as const }, { kind: 'authenticated' as const, mustChangePassword: true }])('requires password change in upstream UI', async result => {
    const { model, client } = fixture(); vi.mocked(client.connect).mockResolvedValue(result); await model.testConnection(); expect(model.error).toContain('lightNVR web UI'); expect(model.tested).toBe(false);
  });
  it('passes session credentials in memory and emits none', async () => {
    const { model, client, emit } = fixture(); model.edit({ ...model.config, credential_storage: 'session', username: 'viewer', password: 'private' }, true);
    await model.testConnection(); expect(client.connect).toHaveBeenCalledWith({ username: 'viewer', password: 'private' }, expect.any(Object)); expect(emit.mock.lastCall![0]).not.toHaveProperty('password'); expect(emit.mock.lastCall![0]).not.toHaveProperty('username');
  });
  it('clearing a session password clears the previous in-memory credential', async () => {
    const { model, client } = fixture(); model.edit({ ...model.config, credential_storage: 'session', username: 'viewer', password: 'old-private' }, true);
    const next = { ...model.config }; delete next.password; model.edit(next, true);
    await model.testConnection(); expect(client.connect).toHaveBeenLastCalledWith({ username: 'viewer', password: '' }, expect.any(Object));
  });
  it('cancel invalidates test state and aborts pending discovery', async () => {
    const { model, client } = fixture(); await model.testConnection(); model.cancel(); await model.discover();
    expect(model.tested).toBe(false); expect(client.discover).not.toHaveBeenCalled(); expect(model.error).toContain('Test this connection');
  });
  it('preserves advanced fields through edits; rejects unknown fields without emitting', () => {
    const { model, emit } = fixture(); const c = validateConfig({ ...getStubConfig(), ice_servers: [{ urls: 'stun:example.test' }], visibility: { offscreen: 'continue' }, timeouts: { webrtc_ms: 1234 }, viewer_url: 'https://example.test/' });
    model.setConfig(c); model.edit({ ...model.config, title: 'Edited' }); expect(emit.mock.lastCall![0]).toMatchObject({ ice_servers: c.ice_servers, visibility: c.visibility, timeouts: c.timeouts, viewer_url: c.viewer_url });
    emit.mockClear(); expect(model.edit({ ...model.config, unsupported: true })).toBe(false); expect(emit).not.toHaveBeenCalled();
  });
  it('migration preview never applies or connects before explicit application', () => {
    const { model, client, emit } = fixture(); model.previewMigration('server: https://user:private@example.test/go2rtc/\nurl: front_door_sub'); expect(emit).not.toHaveBeenCalled(); expect(client.connect).not.toHaveBeenCalled();
    model.applyMigration(); expect(emit).toHaveBeenCalledOnce(); expect(model.config.server).toBe('https://example.test/'); expect(model.config.source).toBe('front_door_sub');
  });
});

describe('HA custom editor element', () => {
  it('registers only the editor, masks passwords and emits full bubbling composed config', async () => {
    const element = createEditorElement(); expect(element).toBeInstanceOf(LightNvrCardEditor); element.setConfig(getStubConfig()); document.body.append(element); await element.updateComplete;
    const input = [...element.shadowRoot!.querySelectorAll('input')].find(i => i.type === 'password')!; expect(input.type).toBe('password');
    const listener = vi.fn(); document.body.addEventListener('config-changed', listener, { once: true });
    element.model.edit({ ...element.model.config, title: 'New title' });
    const event = listener.mock.calls[0]![0] as CustomEvent; expect(event.bubbles).toBe(true); expect(event.composed).toBe(true); expect(validateConfig(event.detail.config)).toEqual(element.model.config);
    expect(element.shadowRoot!.textContent).toContain('same-origin'); expect(element.shadowRoot!.textContent).toContain('secure Home Assistant document');
  });
  it('renders/searches 251 cameras and disables private/disabled selections', async () => {
    const element = createEditorElement(); const { client } = fixture([...Array.from({ length: 251 }, (_, i) => camera(`camera_${i}`)), camera('private', { privacy: true }), camera('disabled', { status: 'disabled' })]);
    element.clientFactory = () => client; document.body.append(element); await element.model.testConnection(); await element.model.discover(); await element.updateComplete;
    expect(element.shadowRoot!.querySelectorAll('.camera')).toHaveLength(253);
    const privateRow = [...element.shadowRoot!.querySelectorAll('.camera')].find(r => r.textContent!.includes('private'))!; expect(privateRow.querySelector('button')!.disabled).toBe(true);
    const search = element.shadowRoot!.querySelector('input[type=search]') as HTMLInputElement; search.value = 'camera_250'; search.dispatchEvent(new Event('input')); await element.updateComplete; expect(element.shadowRoot!.querySelectorAll('.camera')).toHaveLength(1);
  });
  it('preserves multiline pasted migration YAML while keeping input and preview credentials masked', async () => {
    const element = createEditorElement(); document.body.append(element); await element.updateComplete;
    const input = [...element.shadowRoot!.querySelectorAll('input[type=password]')].at(-1)! as HTMLInputElement;
    const clipboard = new DataTransfer(); clipboard.setData('text/plain', 'server: https://viewer:p%40ss@example.test/go2rtc/\nurl: front_door_sub');
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, cancelable: true })); await element.updateComplete;
    expect(input.type).toBe('password'); const button = [...element.shadowRoot!.querySelectorAll('button')].find(b => b.textContent!.includes('Preview migration'))!; button.click(); await element.updateComplete;
    expect(element.model.migration?.config.source).toBe('front_door_sub'); expect(element.shadowRoot!.querySelector('pre')!.textContent).not.toContain('p@ss');
    expect(element.shadowRoot!.querySelector('pre')!.textContent).not.toContain('viewer:');
  });
  it('previews only authorized snapshots and never controls or acquires media', async () => {
    const element = createEditorElement(); const { client } = fixture(); const mic = vi.fn(); Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: mic } });
    Object.defineProperty(client, 'profile', { value: { baseUrl: 'https://dashboard.test/lightnvr/' } });
    client.mediaUrls = vi.fn().mockReturnValue({ snapshot: 'https://dashboard.test/lightnvr/go2rtc/api/frame.jpeg?src=camera_1_sub' });
    vi.mocked(client.authorizedFetch).mockResolvedValue(new Response(new Blob(['owned fixture'], { type: 'image/jpeg' }), { headers: { 'content-type': 'image/jpeg' } }));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:owned'); const revoke = vi.spyOn(URL, 'revokeObjectURL');
    element.clientFactory = () => client; document.body.append(element); await element.model.testConnection(); await element.model.discover(); await element.updateComplete;
    const button = [...element.shadowRoot!.querySelectorAll('button')].find(b => b.textContent!.includes('Preview main snapshot'))!; button.click(); await vi.waitFor(() => expect(element.shadowRoot!.querySelector('img')).not.toBeNull());
    expect(client.authorizedFetch).toHaveBeenCalledWith('go2rtc/api/frame.jpeg?src=camera_1_sub', expect.objectContaining({ signal: expect.any(AbortSignal) })); expect(mic).not.toHaveBeenCalled(); expect(client.control).not.toHaveBeenCalled(); element.remove(); expect(revoke).toHaveBeenCalledWith('blob:owned');
  });
});
