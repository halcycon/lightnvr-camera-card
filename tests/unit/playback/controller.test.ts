import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NvrError } from '../../../src/contracts';
import { controllers, configuration, deferred, flush, harness, mockClient } from './fixture';

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  const cleanup = Promise.all(controllers.splice(0).map(c => c.dispose()));
  await vi.advanceTimersByTimeAsync(2100); await cleanup;
  expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('transport decisions and bounded recovery', () => {
  it('preserves explicit manual sources with unknown camera identity after successful empty discovery', async () => {
    const api = mockClient(); api.client.discover.mockResolvedValue([]);
    const h = harness({ api }); await h.start({ stream: 'manual-selector', source: 'generated-exact_sub' });
    expect(h.last().context!.source).toEqual({ source: 'generated-exact_sub', profile: 'main' });
    expect(h.last().context!.camera).toBeUndefined(); expect(h.api.client.control).not.toHaveBeenCalled();
  });
  it.each([
    ['unsupported-api', 404], ['unsupported-api', 405], ['unsupported-api', 200], ['proxy', 502],
    ['auth', 401], ['policy', 403], ['privacy', undefined], ['network', undefined],
  ] as const)('never bypasses discovery %s/%s for an explicit manual source', async (code, status) => {
    const api = mockClient(); api.client.discover.mockRejectedValue(new NvrError({ code, message: 'private detail', ...(status ? { status } : {}) }));
    const h = harness({ api }); await h.start({ source: 'generated-exact_sub', retry: { attempts: 0 } });
    await vi.advanceTimersByTimeAsync(100000);
    expect(h.adapters).toHaveLength(0); expect(h.api.client.control).not.toHaveBeenCalled(); expect(h.api.client.authorizedFetch).not.toHaveBeenCalled();
  });
  it('uses WebRTC → MSE → HLS, requiring frames and releasing old media first', async () => {
    const h = harness(); await h.start();
    expect(h.controller.snapshot.state).toBe('connecting');
    h.last().fail('ice'); await flush();
    expect(h.adapters.map(a => a.kind)).toEqual(['webrtc', 'mse']);
    expect(h.log.indexOf('talk-stop', h.log.indexOf('start-webrtc'))).toBeLessThan(h.log.indexOf('stop-webrtc'));
    expect(h.log.indexOf('stop-webrtc')).toBeLessThan(h.log.indexOf('start-mse'));
    h.last().fail('unsupported-codec'); await flush(); h.last().frame();
    expect(h.adapters.map(a => a.kind)).toEqual(['webrtc', 'mse', 'hls']);
    expect(h.controller.snapshot.state).toBe('playing');
    expect(h.api.client.control).not.toHaveBeenCalled();
    expect(h.api.client.authorizedFetch).not.toHaveBeenCalled();
  });
  it('deduplicates WebRTC failure event plus setup rejection', async () => {
    const h = harness({ setup: async (a) => { if (a.kind === 'webrtc') { a.fail('ice'); throw new NvrError({ code: 'ice', message: 'private' }); } } });
    await h.start(); await flush();
    expect(h.adapters.map(a => a.kind)).toEqual(['webrtc', 'mse']);
    expect(h.adapters[0]!.stop).toHaveBeenCalledOnce(); expect(h.last().stop).not.toHaveBeenCalled();
  });
  it.each(['webrtc', 'mse', 'hls'])('fixed %s retries only itself and exhausts', async kind => {
    const h = harness(); await h.start({ transports: [kind] });
    for (const delay of [100, 200]) { h.last().fail('network'); await flush(); await vi.advanceTimersByTimeAsync(delay); }
    h.last().fail('network'); await flush(); await vi.advanceTimersByTimeAsync(10000);
    expect(h.adapters.map(a => a.kind)).toEqual([kind, kind, kind]);
    expect(h.controller.snapshot.state).toBe('failed');
    await h.controller.retry(); expect(h.adapters.map(a => a.kind)).toEqual([kind, kind, kind, kind]);
  });
  it('honors custom order and ignores upstream first-renderer hints', async () => {
    const api = mockClient(); api.camera.preferredTransport = 'webrtc'; api.settings.defaultTransport = 'webrtc';
    const h = harness({ api }); await h.start({ transports: ['mse', 'hls'] }); h.last().fail('buffer'); await flush();
    expect(h.adapters.map(a => a.kind)).toEqual(['mse', 'hls']);
  });
  it('skips server-disabled renderers without starting them', async () => {
    const api = mockClient(); api.settings.transports = { webrtc: 'denied', mse: 'denied', hls: 'allowed' };
    const h = harness({ api }); await h.start(); expect(h.adapters.map(a => a.kind)).toEqual(['hls']);
  });
  it('forceNativeHls selects an HLS provider and does not disable WebRTC/MSE', async () => {
    const api = mockClient(); api.settings.forceNativeHls = true;
    const h = harness({ api }); await h.start(); h.last().fail('ice'); await flush(); h.last().fail('unsupported-codec'); await flush();
    expect(h.adapters.map(a => a.kind)).toEqual(['webrtc', 'mse', 'hls']);
  });
  it('disabled go2rtc skips WebRTC/MSE even without forceNativeHls', async () => {
    const api = mockClient(); api.settings.go2rtc = 'denied';
    const h = harness({ api }); await h.start(); expect(h.adapters.map(a => a.kind)).toEqual(['hls']);
  });
  it('fixed unsupported mode never changes transport', async () => {
    const api = mockClient(); api.settings.transports = { webrtc: 'denied', mse: 'allowed', hls: 'allowed' };
    const h = harness({ api }); await h.start({ transports: ['webrtc'], retry: { attempts: 0 } });
    expect(h.adapters).toHaveLength(0); expect(h.controller.snapshot.state).toBe('failed');
  });
  it.each([['auth', undefined, 'auth-required'], ['network', 401, 'auth-required'], ['policy', undefined, 'denied'], ['network', 403, 'denied'], ['privacy', undefined, 'denied'], ['configuration', undefined, 'failed']])('does not retry or fallback for %s/%s', async (code, status, state) => {
    const h = harness(); await h.start(); h.last().fail(code!, status as number | undefined); await flush();
    await vi.advanceTimersByTimeAsync(100000);
    expect(h.adapters).toHaveLength(1); expect(h.controller.snapshot.state).toBe(state);
    expect(h.controller.snapshot.failure?.message).not.toContain('untrusted'); expect(h.last().stop).toHaveBeenCalledOnce();
  });
  it.each(['privacy', 'denied', 'offline'] as const)('honors inventory %s before adapter construction', async condition => {
    const api = mockClient();
    if (condition === 'privacy') api.camera.privacy = true;
    if (condition === 'denied') api.camera.capabilities = { 'live.view': 'denied' };
    if (condition === 'offline') api.camera.status = 'offline';
    const h = harness({ api }); await h.start({ retry: { attempts: 0 } });
    expect(h.adapters).toHaveLength(0); expect(h.controller.snapshot.state).toBe(condition === 'offline' ? 'offline' : 'denied');
  });
  it('source-offline retries the same renderer with capped exponential backoff', async () => {
    const h = harness(); await h.start({ retry: { attempts: 4, base_ms: 100, cap_ms: 250, jitter: 0 } });
    for (const delay of [100, 200, 250, 250]) {
      h.last().fail('source-offline'); await flush(); expect(h.controller.snapshot.state).toBe('offline');
      const count = h.adapters.length;
      await vi.advanceTimersByTimeAsync(delay - 1); expect(h.adapters).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1); expect(h.adapters).toHaveLength(count + 1);
    }
    h.last().fail('source-offline'); await flush(); await vi.advanceTimersByTimeAsync(10000);
    expect(h.adapters.map(a => a.kind)).toEqual(Array(5).fill('webrtc')); expect(h.api.client.control).not.toHaveBeenCalled();
  });
  it('rate limiting backs off on the same renderer and respects Retry-After', async () => {
    const h = harness(); await h.start();
    h.last().context!.emit({ type: 'failure', failure: { code: 'rate-limit', message: '', retryAfterMs: 350 } }); await flush();
    await vi.advanceTimersByTimeAsync(349); expect(h.adapters).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(h.adapters.map(a => a.kind)).toEqual(['webrtc', 'webrtc']);
  });
  it('uses transport first-frame deadlines then exhausts bounded rounds', async () => {
    const h = harness(); await h.start({ timeouts: { connection_ms: 500, webrtc_ms: 100, mse_ms: 200, hls_ms: 300 }, retry: { attempts: 0 } });
    await vi.advanceTimersByTimeAsync(99); expect(h.adapters).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(h.adapters.map(a => a.kind)).toEqual(['webrtc', 'mse']);
    await vi.advanceTimersByTimeAsync(200); expect(h.adapters.map(a => a.kind)).toEqual(['webrtc', 'mse', 'hls']);
    await vi.advanceTimersByTimeAsync(300); expect(h.controller.snapshot.state).toBe('failed');
    expect(h.adapters.every(a => vi.mocked(a.stop).mock.calls.length === 1)).toBe(true);
  });
  it('inherits the server deadline for decoded media', async () => {
    const api = mockClient(); api.settings.connectionTimeoutMs = 150;
    const h = harness({ api }); await h.start({ timeouts: { connection_ms: 'inherit' }, transports: ['hls'], retry: { attempts: 0 } });
    await vi.advanceTimersByTimeAsync(149); expect(h.controller.snapshot.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1); expect(h.controller.snapshot.state).toBe('failed');
  });
  it('bounds noncooperative metadata and ignores its late completion', async () => {
    const api = mockClient(), pending = deferred<Awaited<ReturnType<typeof api.client.connect>>>();
    api.client.connect.mockReturnValueOnce(pending.promise);
    const h = harness({ api }); const started = h.start({ retry: { attempts: 0 } }); await flush();
    await vi.advanceTimersByTimeAsync(500); await started;
    expect(h.controller.snapshot.state).toBe('failed');
    pending.resolve({ kind: 'authenticated', mustChangePassword: false }); await flush();
    expect(h.adapters).toHaveLength(0); expect(api.client.discover).not.toHaveBeenCalled();
  });
});

describe('generation and resource ownership', () => {
  it('config replacement aborts old setup and ignores late failure/frame/setup resolution', async () => {
    const pending = deferred<void>(); const h = harness({ setup: async a => { if (a.kind === 'webrtc') await pending.promise; } });
    const old = h.start(); await flush(); const previous = h.last();
    await h.start({ transports: ['hls'], profile: 'sub' }); h.last().frame();
    previous.frame(); previous.fail('auth'); pending.resolve(); await old; await flush();
    expect(previous.context!.signal.aborted).toBe(true); expect(previous.stop).toHaveBeenCalledOnce();
    expect(h.last().context!.source.source).toBe('generated_sub');
    expect(h.controller.snapshot).toMatchObject({ state: 'playing', transport: 'hls' });
  });
  it('stop during backoff cancels all future starts and manual retry is local', async () => {
    const h = harness(); await h.start(); h.last().fail('source-offline'); await flush(); await h.controller.stop();
    await vi.advanceTimersByTimeAsync(10000); expect(h.adapters).toHaveLength(1);
    await h.controller.retry(); expect(h.adapters).toHaveLength(2); expect(h.api.client.control).not.toHaveBeenCalled();
  });
  it('does not restart healthy playback for repeated equal config/hass render updates', async () => {
    const h = harness(); await h.start(); h.last().frame();
    for (let i = 0; i < 25; i++) await h.controller.start(h.video.asVideo(), structuredClone(configuration()));
    expect(h.adapters).toHaveLength(1); expect(h.controller.snapshot.state).toBe('playing');
  });
  it('external cancellation and disposal cannot resurrect stale media', async () => {
    const h = harness(), abort = new AbortController();
    await h.controller.start(h.video.asVideo(), configuration(), abort.signal); const old = h.last(); abort.abort(); await flush();
    old.frame(); old.fail('network'); await vi.advanceTimersByTimeAsync(10000);
    expect(h.controller.snapshot.state).toBe('stopped'); expect(h.adapters).toHaveLength(1);
    await h.controller.dispose(); await h.start(); await h.controller.retry(); expect(h.adapters).toHaveLength(1);
  });
  it('hides/releases and shows a new generation without resuming talk', async () => {
    const h = harness(); await h.start({ audio: { microphone: true } }); h.last().frame();
    await h.controller.startTalk(new AbortController().signal); expect(h.controller.snapshot.talking).toBe(true);
    await h.controller.setVisible(false); expect(h.controller.snapshot.state).toBe('suspended'); expect(h.controller.snapshot.talking).toBe(false);
    expect(h.last().stop).toHaveBeenCalledOnce(); await h.controller.setVisible(true);
    expect(h.adapters).toHaveLength(2); h.last().frame(); expect(h.controller.snapshot.talking).toBe(false);
    expect(h.talk.start).toHaveBeenCalledOnce();
  });
  it('offscreen continue preserves video but always stops talk', async () => {
    const h = harness(); await h.start({ visibility: { offscreen: 'continue' }, audio: { microphone: true } }); h.last().frame();
    await h.controller.startTalk(new AbortController().signal); await h.controller.setVisible(false); await h.controller.setVisible(true);
    expect(h.adapters).toHaveLength(1); expect(h.last().stop).not.toHaveBeenCalled(); expect(h.controller.snapshot.talking).toBe(false);
  });
  it('document hide policy is independent of offscreen continue', async () => {
    const document = Object.assign(new EventTarget(), { hidden: false }); vi.stubGlobal('document', document);
    const h = harness(); await h.start({ visibility: { offscreen: 'continue', hidden: 'pause' } }); h.last().frame();
    document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); await flush(); expect(h.controller.snapshot.state).toBe('suspended');
    await h.controller.setVisible(false); document.hidden = false; document.dispatchEvent(new Event('visibilitychange')); await flush();
    expect(h.adapters).toHaveLength(2);
    await h.controller.dispose(); document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); await flush(); expect(h.adapters).toHaveLength(2);
  });
  it('removing one same-source card preserves another card, client and media', async () => {
    const api = mockClient(), first = harness({ api }), second = harness({ api });
    await Promise.all([first.start(), second.start()]); first.last().frame(); second.last().frame();
    expect(first.last()).not.toBe(second.last()); expect(first.last().context!.video).not.toBe(second.last().context!.video);
    await first.controller.dispose(); expect(second.controller.snapshot.state).toBe('playing');
    expect(second.last().stop).not.toHaveBeenCalled(); expect(api.client.dispose).not.toHaveBeenCalled();
    await second.controller.retry(); expect(first.adapters).toHaveLength(1); expect(second.adapters).toHaveLength(2);
  });
  it('snapshots include immutable talk observations and isolate failing subscribers', async () => {
    const h = harness(), listener = vi.fn(); const unsubscribe = h.controller.subscribe(listener);
    h.controller.subscribe(() => { throw new Error('observer'); });
    await h.start(); h.audio.update({ active: true, pending: false, level: 0.5 });
    expect(h.controller.snapshot).toMatchObject({ talking: true, talk: { level: 0.5 } });
    expect(Object.isFrozen(h.controller.snapshot)).toBe(true); expect(Object.isFrozen(h.controller.snapshot.talk)).toBe(true);
    unsubscribe(); const count = listener.mock.calls.length; await h.controller.stop(); expect(listener).toHaveBeenCalledTimes(count);
    await h.controller.dispose(); expect(h.audio.listeners.size).toBe(0);
  });
});
