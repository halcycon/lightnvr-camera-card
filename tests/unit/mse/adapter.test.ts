import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMseAdapter } from '../../../src/transports/mse';
import { FakeSource, FakeSocket, fixture } from './fixture';

beforeEach(() => { vi.useFakeTimers(); FakeSource.instances = []; FakeSource.isTypeSupported.mockReturnValue(true); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
async function start(extra = {}) {
  const f = fixture(extra), socket = new FakeSocket(), revoke = vi.fn();
  const adapter = createMseAdapter({ mediaSource: FakeSource as unknown as typeof MediaSource,
    createWebSocket: () => socket as unknown as WebSocket, createObjectURL: () => 'blob:generated', revokeObjectURL: revoke });
  await adapter.start(f.context);
  const source = FakeSource.instances.at(-1)!;
  return { ...f, adapter, socket, source, buffer: source.buffer, revoke };
}
function negotiate(f: Awaited<ReturnType<typeof start>>) {
  f.socket.open(); f.source.open(); f.socket.message(JSON.stringify({ type: 'mse', value: 'video/mp4; codecs="avc1.640029,mp4a.40.2"' }));
}
describe('MSE adapter', () => {
  it('negotiates only after both opens and waits for a rendered frame', async () => {
    const f = await start(); f.source.open(); expect(f.socket.send).not.toHaveBeenCalled(); f.socket.open(); f.source.open();
    expect(f.socket.send).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual([]); f.video.frame(); f.video.frame();
    expect(f.events).toEqual([{ type: 'first-frame', transport: 'mse' }]);
    await vi.advanceTimersByTimeAsync(31000); expect(f.events).toHaveLength(1); await f.adapter.stop();
  });
  it('serializes binary appends and trims a live window to ten seconds', async () => {
    const f = await start(); negotiate(f);
    f.socket.message(new ArrayBuffer(8)); f.socket.message(new ArrayBuffer(16));
    expect(f.buffer.appendBuffer).toHaveBeenCalledTimes(1);
    f.buffer.ranges = [[0, 40]]; f.buffer.done();
    expect(f.buffer.remove).toHaveBeenCalledWith(0, 30); expect(f.video.currentTime).toBe(39);
    f.buffer.done(); expect(f.buffer.appendBuffer).toHaveBeenCalledTimes(2);
    await f.adapter.stop(); expect(f.buffer.abort).toHaveBeenCalled(); expect(f.source.removeSourceBuffer).toHaveBeenCalled();
  });
  it('recovers a quota failure once by evicting older media', async () => {
    const f = await start(); negotiate(f); f.buffer.ranges = [[0, 5]];
    f.buffer.appendBuffer.mockImplementationOnce(() => { throw new DOMException('generated', 'QuotaExceededError'); });
    f.socket.message(new ArrayBuffer(8)); expect(f.buffer.remove).toHaveBeenCalledWith(0, 3);
    f.buffer.done(); expect(f.buffer.appendBuffer).toHaveBeenCalledTimes(2); expect(f.events).toEqual([]); await f.adapter.stop();
  });
  it('accepts supported lower H.264 profiles and bounds repeated quota recovery', async () => {
    const f = await start(); f.socket.open(); f.source.open();
    f.socket.message(JSON.stringify({ type: 'mse', value: 'video/mp4; codecs="avc1.42c00a,mp4a.40.2"' }));
    expect(f.source.addSourceBuffer).toHaveBeenCalledOnce();
    f.buffer.ranges = [[0, 5]];
    f.buffer.appendBuffer.mockImplementation(() => { throw new DOMException('', 'QuotaExceededError'); });
    f.socket.message(new ArrayBuffer(8)); f.buffer.done();
    expect(f.buffer.appendBuffer).toHaveBeenCalledTimes(2);
    expect(f.events).toMatchObject([{ failure: { code: 'buffer' } }]); await f.adapter.stop();
  });
  it.each(['binary-before-negotiation', 'overflow', 'chunk-count', 'quota', 'unsupported-codec', 'audio-injection', 'malformed'])('fails safely on %s', async reason => {
    const f = await start(reason === 'audio-injection' ? { audio: { listen: false } } : {});
    if (reason !== 'binary-before-negotiation') {
      if (['unsupported-codec', 'audio-injection', 'malformed'].includes(reason)) {
        f.socket.open(); f.source.open();
        f.socket.message(reason === 'malformed' ? '{' : JSON.stringify({ type: 'mse', value: reason === 'audio-injection' ? 'video/mp4; codecs="avc1.640029,mp4a.40.2"' : 'video/mp4; codecs="unadvertised"' }));
      } else negotiate(f);
    }
    if (reason === 'quota') f.buffer.appendBuffer.mockImplementation(() => { throw new DOMException('', 'QuotaExceededError'); });
    if (reason === 'chunk-count') { f.buffer.updating = true; for (let i = 0; i < 129; i++) f.socket.message(new ArrayBuffer(1)); }
    if (['binary-before-negotiation', 'overflow', 'quota'].includes(reason)) f.socket.message(new ArrayBuffer(reason === 'overflow' ? 5 * 1024 * 1024 : 8));
    expect(f.events).toHaveLength(1); expect(f.events[0]?.type).toBe('failure'); expect(f.socket.close).toHaveBeenCalledTimes(1);
    expect(f.revoke).toHaveBeenCalledWith('blob:generated'); await f.adapter.stop();
  });
  it('does not advertise audio when listen is denied; local mute does not remove negotiation', async () => {
    const f = await start({ audio: { listen: false } }); f.socket.open(); f.source.open();
    expect(f.socket.send.mock.calls[0]?.[0]).not.toContain('mp4a'); await expect(f.adapter.setListening(true)).rejects.toMatchObject({ failure: { code: 'policy' } }); await f.adapter.stop();
    const muted = await start(); muted.socket.open(); muted.source.open(); expect(muted.socket.send.mock.calls[0]?.[0]).toContain('mp4a'); await muted.adapter.setListening(true); expect(muted.video.muted).toBe(false); await muted.adapter.stop();
  });
  it.each(['close', 'error'])('treats opaque WS %s as terminal possible authority denial', async type => {
    const f = await start(); f.socket.dispatchEvent(new Event(type));
    expect(f.events).toMatchObject([{ type: 'failure', failure: { code: 'policy' } }]); await f.adapter.stop();
  });
  it('cleans up abort, callbacks, timers and ignores late old socket events on restart', async () => {
    const f = await start(); negotiate(f); f.abort.abort(); f.socket.message(new ArrayBuffer(8)); f.socket.dispatchEvent(new Event('close'));
    expect(f.events).toEqual([]); expect(f.video.cancelVideoFrameCallback).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    const next = fixture(); next.context.source = { source: 'generated_sub', profile: 'sub' };
    await f.adapter.start(next.context); f.socket.dispatchEvent(new Event('close')); await f.adapter.stop();
    expect(f.revoke).toHaveBeenCalledTimes(2); expect(f.video.src).toBe('');
  });
  it('isolates late events and old play rejections across a fresh stream-ID start', async () => {
    const first = fixture(), second = fixture(); second.context.source = { source: 'generated_sub', profile: 'sub' };
    const sockets: FakeSocket[] = [], urls: string[] = [];
    const a = createMseAdapter({ mediaSource: FakeSource as unknown as typeof MediaSource,
      createWebSocket: url => { urls.push(url); const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; },
      createObjectURL: () => 'blob:generated', revokeObjectURL: vi.fn() });
    let reject!: (error: Error) => void; first.video.play.mockReturnValueOnce(new Promise((_resolve, rejection) => { reject = rejection; }));
    await a.start(first.context); await a.start(second.context);
    sockets[0]!.message(new ArrayBuffer(10)); sockets[0]!.dispatchEvent(new Event('close')); reject(new DOMException('', 'NotAllowedError'));
    await Promise.resolve(); expect(first.events).toEqual([]); expect(second.events).toEqual([]); expect(urls[1]).toContain('src=generated_sub');
    sockets[1]!.open(); FakeSource.instances.at(-1)!.open(); expect(sockets[1]!.send).toHaveBeenCalledOnce(); await a.stop();
  });
  it('reports a deadline and keeps autoplay blocked from becoming timeout/fallback', async () => {
    const f = await start(); await vi.advanceTimersByTimeAsync(30000); expect(f.events).toMatchObject([{ failure: { code: 'timeout' } }]);
    const next = fixture(); next.video.play.mockRejectedValue(new DOMException('', 'NotAllowedError'));
    await f.adapter.start(next.context); await vi.advanceTimersByTimeAsync(60000);
    expect(next.events).toMatchObject([{ failure: { code: 'autoplay' } }]); expect(next.video.pause).not.toHaveBeenCalled(); await f.adapter.stop();
  });
  it('rejects unavailable codecs, APIs, Basic and cross-origin WS before creating a socket', async () => {
    const f = fixture(), socket = vi.fn();
    const a = createMseAdapter({ mediaSource: FakeSource as unknown as typeof MediaSource, createWebSocket: socket });
    FakeSource.isTypeSupported.mockReturnValue(false); await expect(a.start(f.context)).rejects.toMatchObject({ failure: { code: 'unsupported-codec' } });
    FakeSource.isTypeSupported.mockReturnValue(true);
    f.context.client.profile.auth = 'basic'; await expect(a.start(f.context)).rejects.toMatchObject({ failure: { code: 'configuration' } });
    f.context.client.profile.auth = 'session'; f.context.client.profile.sameOrigin = false; await expect(a.start(f.context)).rejects.toMatchObject({ failure: { code: 'configuration' } }); expect(socket).not.toHaveBeenCalled();
    f.context.client.profile.sameOrigin = true;
    await expect(createMseAdapter().start(f.context)).rejects.toMatchObject({ failure: { code: 'unsupported-api' } });
  });
  it('supports ManagedMediaSource attachment without object URLs', async () => {
    const f = fixture(), socket = new FakeSocket(), create = vi.fn();
    const a = createMseAdapter({ managedMediaSource: FakeSource as unknown as typeof MediaSource, createWebSocket: () => socket as unknown as WebSocket, createObjectURL: create });
    await a.start(f.context); expect(f.video.disableRemotePlayback).toBe(true); expect(f.video.srcObject).toBe(FakeSource.instances.at(-1)); expect(create).not.toHaveBeenCalled(); await a.stop(); expect(f.video.srcObject).toBeNull();
  });
});
