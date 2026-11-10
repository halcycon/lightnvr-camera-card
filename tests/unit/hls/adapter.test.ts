import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Hls, { type HlsConfig, type ErrorData, type Events } from 'hls.js';
import { createHlsAdapter } from '../../../src/transports/hls';
import { fixture } from '../mse/fixture';

class FakeHls {
  static instances: FakeHls[] = [];
  static isSupported = vi.fn(() => true);
  static Events = Hls.Events;
  static ErrorTypes = Hls.ErrorTypes;
  listeners = new Map<string, (...args: unknown[]) => void>();
  destroy = vi.fn(); loadSource = vi.fn(); attachMedia = vi.fn(); recoverMediaError = vi.fn();
  constructor(readonly config: Partial<HlsConfig>) { FakeHls.instances.push(this); }
  on(event: string, callback: (...args: unknown[]) => void) { this.listeners.set(event, callback); }
  emit(event: Events, data: Partial<ErrorData> = {}) { this.listeners.get(event)?.(event, data); }
}
const options = { hls: FakeHls as unknown as typeof Hls };
beforeEach(() => { vi.useFakeTimers(); FakeHls.instances = []; FakeHls.isSupported.mockReturnValue(true); });
afterEach(() => { vi.useRealTimers(); });
describe('HLS adapter', () => {
  it('uses bundled hls.js with short buffers and authorized loaders without asserting first frame on manifest', async () => {
    const f = fixture(), a = createHlsAdapter(options); await a.start(f.context);
    const player = FakeHls.instances[0]!;
    expect(player.config).toMatchObject({ maxBufferLength: 4, maxMaxBufferLength: 8, backBufferLength: 0, enableWorker: false });
    expect(player.config.loader).toBeTypeOf('function');
    player.emit(Hls.Events.MANIFEST_PARSED); expect(f.events).toEqual([]);
    f.video.frame(); expect(f.events).toEqual([{ type: 'first-frame', transport: 'hls' }]);
    await a.setListening(true); expect(f.video.muted).toBe(false); expect('getAudioSender' in a).toBe(false);
    await a.stop(); await a.stop(); expect(player.destroy).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('prefers native playback with scoped cookie auth even when locally default-muted', async () => {
    const f = fixture(); f.video.canPlayType.mockReturnValue('probably');
    const a = createHlsAdapter(options); await a.start(f.context);
    expect(f.video.src).toContain('go2rtc/api/stream.m3u8'); expect(f.video.crossOrigin).toBe('use-credentials'); expect(f.video.muted).toBe(true); expect(FakeHls.instances).toHaveLength(0);
    await a.stop(); expect(f.video.src).toBe('');
  });
  it.each([null, 1, 2, 3, 4])('treats opaque native media error %s as a terminal possible authorization denial', async code => {
    const f = fixture(); f.video.canPlayType.mockReturnValue('probably');
    const a = createHlsAdapter(options); await a.start(f.context);
    f.video.error = code === null ? null : { code };
    f.video.dispatchEvent(new Event('error'));
    expect(f.events).toEqual([{ type: 'failure', failure: { code: 'policy', message: 'Permission denied.' } }]);
    expect(FakeHls.instances).toHaveLength(0); expect(f.video.src).toBe('');
    await vi.advanceTimersByTimeAsync(60000); expect(f.events).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
    f.video.dispatchEvent(new Event('error')); expect(f.events).toHaveLength(1); await a.stop();
  });
  it('treats a native play rejection other than autoplay as an opaque possible denial', async () => {
    const f = fixture(); f.video.canPlayType.mockReturnValue('probably');
    f.video.play.mockRejectedValue(new DOMException('never expose upstream details', 'NotSupportedError'));
    const a = createHlsAdapter(options); await a.start(f.context); await vi.advanceTimersByTimeAsync(60000);
    expect(f.events).toEqual([{ type: 'failure', failure: { code: 'policy', message: 'Permission denied.' } }]);
    expect(FakeHls.instances).toHaveLength(0); expect(f.video.src).toBe(''); await a.stop();
  });
  it.each(['basic', 'cross-origin', 'unscoped'])('uses authorized hls.js instead of injecting native-video headers for %s', async mode => {
    const f = fixture(); f.video.canPlayType.mockReturnValue('probably');
    if (mode === 'basic') f.context.client.profile.auth = 'basic';
    if (mode === 'cross-origin') f.context.client.profile.sameOrigin = false;
    if (mode === 'unscoped') f.context.client.profile.baseUrl = 'https://dashboard.example.invalid/';
    const a = createHlsAdapter(options); await a.start(f.context); expect(FakeHls.instances).toHaveLength(1); expect(f.video.src).toBe(''); await a.stop();
  });
  it('honors force-native and globally disabled go2rtc; never changes a selected substream to main', async () => {
    for (const mode of ['forced', 'disabled']) {
      const f = fixture(); if (mode === 'forced') f.context.capabilities.forceNativeHls = true; else f.context.capabilities.go2rtc = 'denied';
      const a = createHlsAdapter(options); await a.start(f.context); expect(FakeHls.instances.at(-1)?.loadSource.mock.calls[0]?.[0]).toContain('/hls/generated/index.m3u8'); await a.stop();
      f.context.source = { source: 'generated_sub', camera: 'generated', profile: 'sub' };
      await expect(a.start(f.context)).rejects.toMatchObject({ failure: { code: 'configuration' } });
    }
  });
  it('rejects explicit go2rtc when forced native or disabled; native cannot exclude audio', async () => {
    const a = createHlsAdapter(options), f = fixture({ hls: { provider: 'go2rtc' } }); f.context.capabilities.forceNativeHls = true;
    await expect(a.start(f.context)).rejects.toMatchObject({ failure: { code: 'policy' } });
    f.context.capabilities.forceNativeHls = false; f.context.capabilities.go2rtc = 'denied'; await expect(a.start(f.context)).rejects.toMatchObject({ failure: { code: 'policy' } });
    const silent = fixture({ hls: { provider: 'native' }, audio: { listen: false } }); await expect(a.start(silent.context)).rejects.toMatchObject({ failure: { code: 'configuration' } });
  });
  it('restarts from the selected root with a fresh engine and ignores old stream callbacks', async () => {
    const f = fixture(), a = createHlsAdapter(options); await a.start(f.context); const old = FakeHls.instances[0]!;
    const next = fixture(); next.context.source = { source: 'generated_sub', camera: 'generated', profile: 'sub' }; await a.start(next.context);
    expect(old.destroy).toHaveBeenCalledTimes(1); old.emit(Hls.Events.ERROR, { fatal: true, type: Hls.ErrorTypes.NETWORK_ERROR }); old.emit(Hls.Events.MANIFEST_PARSED);
    expect(f.events).toEqual([]); expect(next.events).toEqual([]);
    expect(FakeHls.instances[1]?.loadSource.mock.calls[0]?.[0]).toContain('src=generated_sub'); await a.stop();
  });
  it('allows one media recovery and never falls back across providers on denial', async () => {
    const f = fixture(), a = createHlsAdapter(options); await a.start(f.context); const player = FakeHls.instances[0]!;
    player.emit(Hls.Events.ERROR, { fatal: true, type: Hls.ErrorTypes.MEDIA_ERROR }); expect(player.recoverMediaError).toHaveBeenCalledTimes(1);
    player.emit(Hls.Events.ERROR, { fatal: true, type: Hls.ErrorTypes.MEDIA_ERROR }); expect(f.events.at(-1)).toMatchObject({ failure: { code: 'unsupported-codec' } }); expect(player.destroy).toHaveBeenCalledTimes(1);
    const next = fixture(); await a.start(next.context); FakeHls.instances[1]!.emit(Hls.Events.ERROR, { fatal: false, response: { code: 403, url: '' } });
    expect(next.events).toMatchObject([{ failure: { code: 'policy', status: 403 } }]); expect(FakeHls.instances).toHaveLength(2); await a.stop();
  });
  it('fails without an API, respects abort and cancels first-frame deadline on autoplay block', async () => {
    const f = fixture(), a = createHlsAdapter(options); FakeHls.isSupported.mockReturnValue(false);
    await expect(a.start(f.context)).rejects.toMatchObject({ failure: { code: 'unsupported-api' } }); FakeHls.isSupported.mockReturnValue(true);
    f.video.play.mockRejectedValue(new DOMException('', 'NotAllowedError')); await a.start(f.context); FakeHls.instances[0]!.emit(Hls.Events.MANIFEST_PARSED);
    await vi.advanceTimersByTimeAsync(60000); expect(f.events).toMatchObject([{ failure: { code: 'autoplay' } }]); expect(FakeHls.instances[0]!.destroy).not.toHaveBeenCalled();
    f.abort.abort(); expect(FakeHls.instances[0]!.destroy).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0); await a.stop();
  });
});
