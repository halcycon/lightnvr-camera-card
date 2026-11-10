import type { Loader, LoaderCallbacks, LoaderConfiguration, LoaderContext, LoaderStats } from 'hls.js';
import type { NvrClient } from '../../contracts';
import { failure, safeDiagnostic } from '../../api/safety';

/** Validate before URL normalization so dot segments cannot erase an escape attempt. */
export function mediaPath(client: NvrClient, input: string, parent = client.profile.baseUrl): string {
  if (/[\\\s#]/.test(input) || input.startsWith('//') || input.includes('{$')) throw failure('configuration');
  let path: string;
  try { path = decodeURIComponent(input.split('?')[0]!); } catch { throw failure('configuration'); }
  if (path.includes('%') || path.split('/').some(p => p === '.' || p === '..')) throw failure('configuration');
  const url = new URL(input, parent), base = new URL(client.profile.baseUrl);
  if (url.origin !== base.origin || url.username || url.password || !url.pathname.startsWith(base.pathname)) throw failure('configuration');
  const relative = url.pathname.slice(base.pathname.length);
  const go = new URL(client.profile.go2rtcUrl).pathname.slice(base.pathname.length);
  if (!(relative === `${go}api/stream.m3u8` || (relative.startsWith(`${go}api/hls/`) && /^(playlist\.m3u8|init\.mp4|segment\.ts|segment\.m4s)$/.test(relative.slice(`${go}api/hls/`.length))) || /^hls\/[a-zA-Z0-9_.%-]+\/[a-zA-Z0-9_.-]+$/.test(relative))) throw failure('configuration');
  return relative + url.search;
}
/** Resolve every URI before hls.js sees the playlist; preserve session query bytes. */
export function validatePlaylist(client: NvrClient, text: string, parent: string): void {
  if (!text.trimStart().startsWith('#EXTM3U') || text.length > 1024 * 1024) throw failure('unsupported-api');
  for (const line of text.split(/\r?\n/).map(l => l.trim())) {
    if (!line || line === '#EXTM3U') continue;
    if (!line.startsWith('#')) mediaPath(client, line, parent);
    else {
      // Key, MAP, alternate rendition and low-latency URI attributes share the same boundary.
      const attributes = [...line.matchAll(/(?:^|[:,])(?:[A-Z-]*URI)=("[^"]*"|[^,]*)/g)];
      for (const match of attributes) {
        const value = match[1]!;
        if (!value.startsWith('"') || !value.endsWith('"')) throw failure('configuration');
        mediaPath(client, value.slice(1, -1), parent);
      }
    }
  }
}
function stats(): LoaderStats {
  return { aborted: false, loaded: 0, total: 0, retry: 0, chunkCount: 0, bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } };
}
export function createAuthorizedLoader(client: NvrClient, signal: AbortSignal, onFailure: (error: unknown) => void) {
  return class AuthorizedLoader implements Loader<LoaderContext> {
    context: LoaderContext | null = null;
    stats = stats();
    private controller: AbortController | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private detach: (() => void) | undefined;
    private destroyed = false;
    abort(): void {
      this.stats.aborted = true;
      this.controller?.abort();
      this.clear();
    }
    destroy(): void { this.destroyed = true; this.abort(); this.context = null; }
    private clear(): void { clearTimeout(this.timer); this.timer = undefined; this.detach?.(); this.detach = undefined; }
    load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
      this.abort();
      if (this.destroyed || signal.aborted) return;
      this.context = context; this.stats = stats();
      this.stats.loading.start = performance.now();
      const controller = this.controller = new AbortController();
      const current = () => !this.destroyed && !controller.signal.aborted && this.controller === controller && !signal.aborted;
      const abort = () => this.abort();
      signal.addEventListener('abort', abort, { once: true });
      this.detach = () => signal.removeEventListener('abort', abort);
      const timeout = Math.min(30000, Math.max(100, config.loadPolicy.maxLoadTimeMs));
      this.timer = setTimeout(() => {
        if (!current()) return;
        this.abort();
        onFailure(failure('timeout'));
        if (!signal.aborted && !this.destroyed) callbacks.onTimeout(this.stats, context, null);
      }, timeout);
      void (async () => {
        try {
          const path = mediaPath(client, context.url);
          const headers = new Headers();
          // hls.js 1.7.4 initializes full-fragment loads with the 0/0 sentinel.
          const fullResource = context.rangeStart === 0 && context.rangeEnd === 0;
          if (context.rangeStart !== undefined && !fullResource) {
            const start = context.rangeStart, end = context.rangeEnd;
            if (!Number.isSafeInteger(start) || start < 0 || (end !== undefined && (!Number.isSafeInteger(end) || end <= start))) throw failure('configuration');
            headers.set('Range', `bytes=${start}-${end === undefined ? '' : end - 1}`);
          }
          const response = await client.authorizedFetch(path, { signal: controller.signal, headers, redirect: 'error' });
          if (!current()) { await response.body?.cancel(); return; }
          if (response.redirected || (response.url && response.url !== context.url)) {
            await response.body?.cancel(); throw failure('configuration');
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw failure(response.status === 401 ? 'auth' : response.status === 403 ? 'policy' : response.status === 404 ? 'source-offline' : 'network', response.status);
          }
          this.stats.loading.first = performance.now();
          const isText = context.responseType !== 'arraybuffer';
          const maxBytes = isText ? 1024 * 1024 : 16 * 1024 * 1024;
          const reader = response.body?.getReader();
          if (!reader) throw failure('unsupported-api');
          const chunks: Uint8Array[] = [];
          let size = 0;
          const cancelReader = () => { void reader.cancel().catch(() => {}); };
          controller.signal.addEventListener('abort', cancelReader, { once: true });
          try {
            for (;;) {
              const part = await reader.read();
              if (!current()) { await reader.cancel(); return; }
              if (part.done) break;
              size += part.value.byteLength;
              if (size > maxBytes || chunks.length >= 4096) { await reader.cancel(); throw failure('buffer'); }
              chunks.push(part.value);
            }
          } finally { controller.signal.removeEventListener('abort', cancelReader); reader.releaseLock(); }
          if (!current()) return;
          const data = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
          const result = isText ? new TextDecoder().decode(data) : data.buffer;
          if (typeof result === 'string') validatePlaylist(client, result, context.url);
          this.stats.loaded = this.stats.total = size;
          this.stats.loading.end = performance.now();
          this.stats.chunkCount = 1;
          this.clear();
          callbacks.onSuccess({ url: context.url, data: result, code: response.status }, this.stats, context, null);
        } catch (error) {
          if (!current()) return;
          this.clear();
          const diagnostic = safeDiagnostic(error);
          // Report before hls.js can schedule retries. Credentials/policy failures are terminal.
          onFailure(error);
          if (signal.aborted || this.destroyed) return;
          callbacks.onError({ code: diagnostic.status ?? 0, text: diagnostic.message }, context, null, this.stats);
        }
      })();
    }
  };
}
