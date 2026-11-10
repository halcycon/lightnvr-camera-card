import { NvrError } from '../contracts';
import type { Action, CameraSummary, CardConfigV1, ClientConfig, PlaybackSnapshot, PtzAxes } from '../contracts';

export interface Availability { enabled: boolean; reason: string }
/** Unknown grants may be explicitly requested; they are never displayed as authorization. */
export function availability(action: Action, camera?: CameraSummary, denied: ReadonlySet<Action> = new Set()): Availability {
  if (denied.has(action) || camera?.capabilities[action] === 'denied') return { enabled: false, reason: 'Denied or unsupported by server' };
  if ((action === 'snapshot' || action === 'detection') && camera?.privacy === true) return { enabled: false, reason: 'Camera privacy is enabled' };
  if (!camera) return { enabled: false, reason: 'Requires a known canonical camera' };
  if (action === 'ptz' && camera.ptz === 'denied') return { enabled: false, reason: 'PTZ hardware unavailable' };
  return { enabled: true, reason: camera.capabilities[action] === 'allowed' ? '' : 'Permission unverified; server checks each request' };
}
export function audioAvailability(action: 'audio.listen' | 'audio.talk', config: CardConfigV1, snapshot: PlaybackSnapshot, caps?: ClientConfig, camera?: CameraSummary, secure = globalThis.isSecureContext): Availability {
  if (camera?.privacy === true) return { enabled: false, reason: 'Camera privacy is enabled' };
  if (!config.audio.enabled || caps?.audioDisabled === true || camera?.capabilities[action] === 'denied') return { enabled: false, reason: 'Audio disabled or permission denied' };
  if (action === 'audio.listen') return { enabled: config.audio.listen, reason: config.audio.listen ? 'Local speaker only; microphone is independent' : 'Listening disabled in configuration' };
  if (!config.audio.microphone) return { enabled: false, reason: 'Microphone disabled in configuration' };
  if (!secure) return { enabled: false, reason: 'Microphone requires a secure Home Assistant document' };
  const documentUrl = new URL(globalThis.location?.href ?? 'https://dashboard.invalid');
  const serverUrl = new URL(config.server, documentUrl);
  const localDevelopment = serverUrl.protocol === 'http:' && serverUrl.origin === documentUrl.origin && ['localhost', '127.0.0.1', '[::1]'].includes(serverUrl.hostname);
  if (serverUrl.protocol !== 'https:' && !localDevelopment) return { enabled: false, reason: 'Microphone requires trusted HTTPS/WSS to lightNVR' };
  if (camera?.backchannel !== 'allowed') return { enabled: false, reason: 'Compatible camera backchannel has not been confirmed' };
  if (snapshot.transport !== 'webrtc' || snapshot.state !== 'playing') return { enabled: false, reason: 'Microphone requires playing WebRTC with a negotiated backchannel' };
  return { enabled: true, reason: camera.capabilities[action] === 'allowed' ? 'Browser microphone permission is also required' : 'Talk permission unverified; server and browser must authorize' };
}
export function scaledAxes(axes: PtzAxes, speed: number): PtzAxes {
  const scale = Math.max(0.05, Math.min(1, speed));
  return Object.fromEntries(Object.entries(axes).filter(([key]) => key !== 'speed').map(([key, value]) => [key, Math.max(-1, Math.min(1, value!)) * scale]));
}
/** No guessed UI path: API-only proxies require an explicit web UI destination. */
export function viewerLink(config: CardConfigV1, documentUrl = globalThis.location?.href): string | undefined {
  if (!config.viewer_url) return undefined;
  return new URL(config.viewer_url, documentUrl).href;
}
/** Pinned lightNVR formatUtils.getTimelineUrl route; viewer_url is the explicit web root. */
export function timelineLink(config: CardConfigV1, camera?: Pick<CameraSummary, 'name'>, now = new Date(), fullscreen = false, documentUrl = globalThis.location?.href): string | undefined {
  const root = viewerLink(config, documentUrl);
  if (!root || !camera) return root;
  const base = new URL(root); if (!base.pathname.endsWith('/')) base.pathname += '/';
  const timeline = new URL('timeline.html', base);
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${String(now.getFullYear()).padStart(4, '0')}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  // Match upstream local date/time and encode the canonical name as a query value only.
  timeline.search = `?stream=${encodeURIComponent(camera.name)}&date=${date}&time=${time}${fullscreen ? '&fullscreen=1&nav=fine' : ''}`;
  return timeline.href;
}
export async function canvasSnapshot(video: HTMLVideoElement): Promise<Blob> {
  if (!video.videoWidth || !video.videoHeight) throw new Error('No decoded video');
  const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas unavailable');
  context.drawImage(video, 0, 0);
  // toBlob must reject a tainted canvas. No secondary route is attempted after this.
  return new Promise((resolve, reject) => {
    try { canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Snapshot unavailable')), 'image/jpeg'); }
    catch { reject(new Error('Canvas snapshot blocked by browser origin policy')); }
  });
}

/** Bound card-owned snapshot bodies; abort/removal also cancels the reader. */
export async function readSnapshot(response: Response, signal: AbortSignal): Promise<Blob> {
  const reader = response.body?.getReader();
  if (!reader) throw new NvrError({ code: 'unsupported-api', message: '' });
  const parts: Uint8Array<ArrayBuffer>[] = []; let bytes = 0; let timedOut = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const deadline = setTimeout(() => { timedOut = true; cancel(); }, 10000);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) throw new NvrError({ code: 'cancelled', message: '' });
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted || timedOut) throw new NvrError({ code: signal.aborted ? 'cancelled' : 'timeout', message: '' });
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16 * 1024 * 1024 || parts.length >= 4096) throw new NvrError({ code: 'buffer', message: '' });
      parts.push(new Uint8Array(value));
    }
    if (!bytes) throw new NvrError({ code: 'unsupported-api', message: '' });
    return new Blob(parts, { type: response.headers.get('Content-Type') ?? 'image/jpeg' });
  } finally { clearTimeout(deadline); signal.removeEventListener('abort', cancel); cancel(); }
}
