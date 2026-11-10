// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LightNvrCameraCard } from '../../../src/card';
import { LightNvrCardEditor } from '../../../src/editor';
import '../../../src/index';
import { HA_METADATA_KEYS, stripHaMetadata, validateConfig, type CardConfigV1 } from '../../../src/contracts';
import { config, deferred, fixture, flush } from './fixture';

afterEach(async () => { document.body.replaceChildren(); await flush(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount(input: unknown = config(), f = fixture()) {
  const card = document.createElement('lightnvr-camera-card') as LightNvrCameraCard;
  card.viewerRuntime = f.runtime; card.setConfig(input); document.body.append(card); await flush(); await card.updateComplete;
  return { card, ...f };
}
function stored(card: LightNvrCameraCard): CardConfigV1 {
  // Inspect the stored HA boundary without adding a public custom-card API solely for tests.
  return (card as unknown as { configured: CardConfigV1 }).configured;
}
const metadata = [
  { grid_options: { columns: 6, rows: 'auto' } },
  { grid_options: { columns: 'full', rows: 4, min_columns: 3, max_columns: 24, min_rows: 1, max_rows: 8 } },
  { grid_options: { columns: 24, rows: 'auto', future_layout_hint: 'preserved' } },
  { view_layout: { 'grid-area': 'cameras', column: 2, nested: { layout_owned: ['opaque'] } } },
  { layout_options: { grid_columns: 6, grid_rows: 'auto' } },
  { index: 3, view_index: 1, disabled: false },
  { visibility: [{ condition: 'screen', media_query: '(min-width: 600px)' }] },
];

describe('HA metadata acceptance and full-config preservation', () => {
  it.each(metadata)('accepts and preserves standard HA metadata in card and editor: %j', async meta => {
    const input = { ...config(), ...meta }; const validated = validateConfig(input);
    expect(validated).toMatchObject(meta);
    const { card, playback } = await mount(input);
    expect(stored(card)).toEqual(validated); expect(vi.mocked(playback.start).mock.calls[0]![1]).toEqual(validated);
    const editor = new LightNvrCardEditor(); editor.setConfig(input); expect(editor.model.config).toEqual(validated);
    let emitted: CardConfigV1 | undefined;
    editor.addEventListener('config-changed', event => { emitted = (event as CustomEvent<{ config: CardConfigV1 }>).detail.config; });
    expect(editor.model.edit({ ...editor.model.config, title: 'Camera title' })).toBe(true);
    expect(emitted).toMatchObject(meta); editor.model.dispose();
  });
  it('keeps native HA conditions separate from playback visibility policy', async () => {
    const conditions = [{ condition: 'screen', media_query: '(min-width: 600px)' }];
    const input = config({ visibility: conditions, playback_visibility: { hidden: 'continue', offscreen: 'pause' } });
    const { card, playback } = await mount(input);
    expect(stored(card).visibility).toEqual(conditions);
    expect(stored(card).playback_visibility).toEqual({ hidden: 'continue', offscreen: 'pause' });
    expect(stripHaMetadata(stored(card)).visibility).toBeUndefined();
    expect(stripHaMetadata(stored(card)).playback_visibility).toEqual(input.playback_visibility);
    card.setConfig({ ...input, visibility: [{ condition: 'user', users: ['generated-user'] }] }); await flush();
    expect(playback.start).toHaveBeenCalledOnce();
  });
  it('rejects unrelated unknown application options', () => {
    expect(() => new LightNvrCameraCard().setConfig({ ...config(), invented_camera_admin: true })).toThrow('Invalid lightNVR card configuration');
  });
});

describe('metadata changes do not change media identity', () => {
  it.each(metadata)('updates stored HA config without media/auth/talk teardown: %j', async meta => {
    const input = config(); const { card, playback, client, runtime } = await mount(input);
    vi.mocked(playback.stopTalk).mockClear();
    const video = card.shadowRoot!.querySelector('video');
    card.setConfig({ ...input, ...meta }); await flush();
    expect(stored(card)).toMatchObject(meta); expect(card.shadowRoot!.querySelector('video')).toBe(video);
    expect(runtime.client).toHaveBeenCalledOnce(); expect(client.connect).toHaveBeenCalledOnce(); expect(client.discover).toHaveBeenCalledOnce();
    expect(playback.start).toHaveBeenCalledOnce(); expect(playback.stopTalk).not.toHaveBeenCalled(); expect(playback.dispose).not.toHaveBeenCalled(); expect(client.dispose).not.toHaveBeenCalled();
    expect(card.getGridOptions()).toEqual({ columns: 12, rows: 'auto', min_columns: 3 });
  });
  it('preserves an active toggle microphone and gesture signal across resize/conditions/placement changes', async () => {
    vi.stubGlobal('isSecureContext', true);
    const input = config({ audio: { microphone: true, talk_mode: 'toggle' } }); const { card, playback, emit } = await mount(input);
    const mic = card.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Toggle microphone"]')!;
    mic.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 9, button: 0, bubbles: true }));
    mic.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, button: 0, bubbles: true }));
    emit({ talk: { active: true, pending: false, level: .2 }, talking: true }); await flush();
    const gesture = vi.mocked(playback.startTalk).mock.calls[0]![0]; vi.mocked(playback.stopTalk).mockClear();
    card.setConfig({ ...input, grid_options: { columns: 24, rows: 5 }, view_layout: { 'grid-area': 'camera' }, visibility: [{ condition: 'screen', media_query: '(min-width: 1px)' }], index: 2, view_index: 1, disabled: false }); await flush();
    expect(gesture.aborted).toBe(false); expect(playback.stopTalk).not.toHaveBeenCalled(); expect(playback.start).toHaveBeenCalledOnce(); expect(playback.dispose).not.toHaveBeenCalled();
    expect(card.shadowRoot!.querySelector('[aria-label="Toggle microphone"]')).toBe(mic); expect(card.shadowRoot!.textContent).toContain('Microphone active');
    card.remove(); expect(gesture.aborted).toBe(true);
  });
  it('handles metadata removal and preserves the latest metadata through later recreation', async () => {
    const first = fixture(), second = fixture();
    first.runtime.client = vi.fn().mockReturnValueOnce(first.client).mockReturnValue(second.client);
    first.runtime.playback = vi.fn().mockReturnValueOnce(first.playback).mockReturnValue(second.playback);
    const initial = config({ grid_options: { columns: 6 }, view_layout: { column: 2 }, visibility: [{ condition: 'user', users: ['generated'] }], index: 1 });
    const { card } = await mount(initial, first);
    const latest = config({ layout_options: { grid_columns: 'full' }, disabled: false, view_index: 3 });
    card.setConfig(latest); await flush(); expect(first.playback.start).toHaveBeenCalledOnce(); expect(stored(card)).toEqual(latest);
    for (const key of ['grid_options', 'view_layout', 'visibility', 'index'] as const) expect(Object.hasOwn(stored(card), key)).toBe(false);
    card.remove(); await flush(); document.body.append(card); await flush();
    expect(vi.mocked(second.playback.start).mock.calls[0]![1]).toEqual(latest);
  });
  it('does not supersede a pending login when only layout metadata changes', async () => {
    const f = fixture(); const login = deferred<Awaited<ReturnType<typeof f.client.connect>>>(); vi.mocked(f.client.connect).mockReturnValue(login.promise);
    const { card } = await mount(config(), f); const signal = vi.mocked(f.client.connect).mock.calls[0]![1]!.signal!;
    card.setConfig(config({ grid_options: { columns: 6 } })); await flush(); expect(signal.aborted).toBe(false); expect(f.runtime.client).toHaveBeenCalledOnce();
    login.resolve({ kind: 'authenticated', mustChangePassword: false }); await flush(); expect(f.playback.start).toHaveBeenCalledOnce(); expect(stored(card).grid_options).toEqual({ columns: 6 });
  });
  it('restarts when the playback policy changes and keeps HA metadata out of the identity comparison', async () => {
    const { card, playback } = await mount();
    card.setConfig(config({ playback_visibility: { hidden: 'continue', offscreen: 'continue' }, grid_options: { columns: 6 } })); await flush();
    expect(playback.start).toHaveBeenCalledTimes(2); expect(playback.dispose).toHaveBeenCalledOnce();
    expect(vi.mocked(playback.start).mock.calls.at(-1)![1].playback_visibility).toEqual({ hidden: 'continue', offscreen: 'continue' });
    expect(HA_METADATA_KEYS).not.toContain('playback_visibility');
  });
  it('preserves local fullscreen main selection and latest metadata until exit restores sub', async () => {
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
    const input = config({ profile: 'sub', layout: { fullscreen_main: true } }); const { card, playback } = await mount(input);
    const fullscreen = vi.spyOn(document, 'fullscreenElement', 'get').mockReturnValue(card); document.dispatchEvent(new Event('fullscreenchange')); await flush();
    card.setConfig({ ...input, grid_options: { columns: 24 } }); await flush();
    expect(playback.start).toHaveBeenCalledTimes(2); expect(vi.mocked(playback.start).mock.calls.at(-1)![1].profile).toBe('main');
    fullscreen.mockReturnValue(null); document.dispatchEvent(new Event('fullscreenchange')); await flush();
    const restored = vi.mocked(playback.start).mock.calls.at(-1)![1]; expect(restored.profile).toBe('sub'); expect(restored.grid_options).toEqual({ columns: 24 });
  });
  it('keeps local volume changes separate from the HA config baseline on a later resize', async () => {
    const input = config(); const { card, playback } = await mount(input);
    const volume = card.shadowRoot!.querySelector<HTMLInputElement>('[aria-label="Speaker volume"]')!; volume.value = '.25'; volume.dispatchEvent(new Event('input')); await flush();
    card.setConfig({ ...input, grid_options: { columns: 6 } }); await flush();
    expect(playback.start).toHaveBeenCalledOnce(); expect(card.shadowRoot!.querySelector('video')!.volume).toBe(.25); expect(stored(card).audio.volume).toBe(1);
  });
});

describe('legacy playback visibility normalization', () => {
  it('normalizes the old object spelling and treats its canonical echo as the same media config', async () => {
    const legacy: Record<string, unknown> = { ...config(), visibility: { hidden: 'continue', offscreen: 'pause' }, grid_options: { columns: 24 } }; delete legacy.playback_visibility;
    const { card, playback } = await mount(legacy);
    expect(stored(card).visibility).toBeUndefined(); expect(stored(card).playback_visibility).toEqual({ hidden: 'continue', offscreen: 'pause' });
    card.setConfig(config({ playback_visibility: { hidden: 'continue', offscreen: 'pause' }, grid_options: { columns: 24 } })); await flush(); expect(playback.start).toHaveBeenCalledOnce();
  });
  it('rejects an ambiguous legacy object plus a new policy', () => {
    expect(() => new LightNvrCameraCard().setConfig({ ...config(), visibility: { hidden: 'continue', offscreen: 'pause' } })).toThrow('Invalid lightNVR card configuration');
  });
});
