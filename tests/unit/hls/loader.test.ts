import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoaderContextType, type LoaderConfiguration, type LoaderContext } from 'hls.js';
import { createAuthorizedLoader, mediaPath, validatePlaylist } from '../../../src/transports/hls/loader';
import { createClientFactory } from '../../../src/api';
import { fixture } from '../mse/fixture';
const config: LoaderConfiguration = { loadPolicy: { maxTimeToFirstByteMs: 1000, maxLoadTimeMs: 2000, timeoutRetry: null, errorRetry: null }, maxRetry: 0, timeout: 2000, retryDelay: 0, maxRetryDelay: 0 };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function setup() {
  const f = fixture(), failure = vi.fn(), Loader = createAuthorizedLoader(f.context.client, f.abort.signal, failure), loader = new Loader();
  const callbacks = { onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn() };
  const context: LoaderContext = { url: f.context.client.profile.go2rtcUrl + 'api/stream.m3u8?src=generated&mp4=flac', responseType: 'text', type: LoaderContextType.MANIFEST };
  return { ...f, client: f.context.client, failure, loader, callbacks, context };
}
afterEach(() => { vi.useRealTimers(); });
describe('authorized HLS loader', () => {
  it('retains prefix and session bytes from master through child playlist, init and segment', async () => {
    const f = setup();
    const steps = [
      ['go2rtc/api/stream.m3u8?src=generated&mp4=flac', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000\nhls/playlist.m3u8?id=generated%2Bsession\n'],
      ['go2rtc/api/hls/playlist.m3u8?id=generated%2Bsession', '#EXTM3U\n#EXT-X-MAP:URI="init.mp4?id=generated%2Bsession"\n#EXTINF:1,\nsegment.m4s?id=generated%2Bsession&n=1\n'],
      ['go2rtc/api/hls/init.mp4?id=generated%2Bsession', new Uint8Array([0, 1, 2])],
      ['go2rtc/api/hls/segment.m4s?id=generated%2Bsession&n=1', new Uint8Array([3, 4, 5])],
    ] as const;
    for (const [path, data] of steps) {
      f.authorizedFetch.mockResolvedValueOnce(new Response(data));
      f.loader.load({ ...f.context, url: f.client.profile.baseUrl + path, responseType: typeof data === 'string' ? 'text' : 'arraybuffer' }, config, f.callbacks);
      await flush(); expect(f.authorizedFetch.mock.calls.at(-1)?.[0]).toBe(path);
    }
    expect(f.callbacks.onSuccess).toHaveBeenCalledTimes(4); expect(f.failure).not.toHaveBeenCalled(); f.loader.destroy();
  });
  it.each([401, 403, 404])('reports %i without retries or provider changes', async status => {
    const f = setup(); f.authorizedFetch.mockResolvedValueOnce(new Response('private raw upstream text', { status })); f.loader.load(f.context, config, f.callbacks); await flush();
    expect(f.failure.mock.calls[0]?.[0]).toMatchObject({ failure: { code: status === 401 ? 'auth' : status === 403 ? 'policy' : 'source-offline', status } });
    expect(JSON.stringify(f.callbacks.onError.mock.calls)).not.toContain('private raw'); expect(f.authorizedFetch).toHaveBeenCalledTimes(1); f.loader.destroy();
  });
  it.each(['https://foreign.example.invalid/hls/x/index.m3u8', '//foreign.example.invalid/a', '/outside/a', '/nvr/front/hls/x/../a', 'https://user:pass@dashboard.example.invalid/nvr/front/hls/x/a', '/nvr/front/go2rtc/api/streams', '/nvr/front/hls/x/%252e%252e', '/nvr/front/hls/x/%2e%2e'])('rejects unsafe URL %s before authorized fetch', async url => {
    const f = setup(); f.loader.load({ ...f.context, url }, config, f.callbacks); await flush(); expect(f.authorizedFetch).not.toHaveBeenCalled(); expect(f.failure).toHaveBeenCalledOnce(); f.loader.destroy();
  });
  it('validates every URI form before passing a manifest to hls.js', async () => {
    const f = setup();
    for (const text of ['#EXTM3U\nhttps://foreign.example.invalid/segment.ts', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://foreign.example.invalid/key"', '#EXTM3U\n#EXT-X-MAP:URI=/nvr/front/hls/x/a', '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="/outside/a"']) {
      expect(() => validatePlaylist(f.client, text, f.context.url)).toThrow();
    }
    expect(mediaPath(f.client, '/nvr/front/go2rtc/api/hls/init.mp4?id=generated%2Bsession')).toBe('go2rtc/api/hls/init.mp4?id=generated%2Bsession');
    f.authorizedFetch.mockResolvedValueOnce(new Response('#EXTM3U\nhttps://foreign.example.invalid/segment.ts')); f.loader.load(f.context, config, f.callbacks); await flush(); expect(f.callbacks.onSuccess).not.toHaveBeenCalled(); f.loader.destroy();
  });
  it('rejects redirects and oversized responses and sends only validated Range headers', async () => {
    const f = setup(); const redirect = new Response(''); Object.defineProperty(redirect, 'redirected', { value: true }); f.authorizedFetch.mockResolvedValueOnce(redirect);
    f.loader.load(f.context, config, f.callbacks); await flush(); expect(f.failure).toHaveBeenCalledOnce();
    f.authorizedFetch.mockResolvedValueOnce(new Response('x'.repeat(1024 * 1024 + 1))); f.loader.load(f.context, config, f.callbacks); await flush(); expect(f.failure).toHaveBeenCalledTimes(2);
    f.authorizedFetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2]))); f.loader.load({ ...f.context, responseType: 'arraybuffer', rangeStart: 2, rangeEnd: 4, headers: { Authorization: 'never-forward', 'X-Arbitrary': 'never-forward' } }, config, f.callbacks); await flush();
    const headers = f.authorizedFetch.mock.calls.at(-1)?.[1]?.headers as Headers;
    expect([...headers]).toEqual([['range', 'bytes=2-3']]); f.loader.destroy();
  });
  it('destroys a pending loader without callbacks and cancels late response bodies', async () => {
    const f = setup(); let resolve!: (r: Response) => void; f.authorizedFetch.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    f.loader.load(f.context, config, f.callbacks); f.loader.destroy(); const cancel = vi.fn(); resolve(new Response(new ReadableStream({ cancel })));
    await flush(); expect(cancel).toHaveBeenCalled(); expect(f.callbacks.onSuccess).not.toHaveBeenCalled(); expect(f.callbacks.onError).not.toHaveBeenCalled(); expect(f.failure).not.toHaveBeenCalled();
  });
  it('bounds hung body consumption, parent abort and timer disposal', async () => {
    vi.useFakeTimers(); const f = setup();
    const cancel = vi.fn(); f.authorizedFetch.mockImplementationOnce(async (_path, init) => new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener('abort', () => controller.error(new DOMException('', 'AbortError'))); }, cancel })));
    f.loader.load(f.context, config, f.callbacks); await vi.advanceTimersByTimeAsync(2001);
    expect(f.callbacks.onTimeout).toHaveBeenCalledOnce(); expect(f.failure).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0); f.loader.destroy();
    const next = setup(); next.loader.load(next.context, config, next.callbacks); next.abort.abort(); await vi.advanceTimersByTimeAsync(3000); expect(next.callbacks.onSuccess).not.toHaveBeenCalled(); expect(next.callbacks.onTimeout).not.toHaveBeenCalled(); next.loader.destroy();
  });
  it.each(['session', 'basic'])('real API preserves %s authentication on all four load types', async auth => {
    const f = fixture({ auth, username: 'fixture-viewer', password: 'generated-fixture-password' });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new Uint8Array([1, 2, 3])));
    const client = createClientFactory({ documentUrl: 'https://dashboard.example.invalid/', fetch: fetch as typeof globalThis.fetch })(f.context.config);
    const Loader = createAuthorizedLoader(client, f.abort.signal, () => {}), loader = new Loader();
    const callbacks = { onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn() };
    for (const path of ['stream.m3u8?src=generated', 'hls/playlist.m3u8?id=generated', 'hls/init.mp4?id=generated', 'hls/segment.m4s?id=generated&n=1']) {
      loader.load({ url: client.profile.go2rtcUrl + 'api/' + path, responseType: 'arraybuffer', type: LoaderContextType.MEDIA_FRAGMENT }, config, callbacks); await flush();
    }
    expect(callbacks.onSuccess).toHaveBeenCalledTimes(4);
    for (const [, init] of fetch.mock.calls) {
      expect(init?.credentials).toBe(auth === 'session' ? 'include' : 'omit');
      expect(new Headers(init?.headers).has('Authorization')).toBe(auth === 'basic'); expect(init?.redirect).toBe('error');
    }
    loader.destroy(); client.dispose();
  });
});
