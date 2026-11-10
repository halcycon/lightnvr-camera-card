// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NvrError, type Action, type Knowledge, type ControlRequest } from '../../../src/contracts';
import { availability, audioAvailability, canvasSnapshot, scaledAxes, timelineLink, viewerLink } from '../../../src/ui/controls';
import { ViewerSession } from '../../../src/ui/session';
import { camera, caps, config, deferred, fixture, flush } from '../card/fixture';
const err = (status: number) => new NvrError({ code: status === 401 ? 'auth' : status === 403 ? 'policy' : 'unsupported-api', status, message: 'unsafe source/password' });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function session(cam = camera(), options: Record<string, unknown> = {}) {
  const f = fixture(cam); const viewer = new ViewerSession(config(options), document.createElement('video'), vi.fn(), f.runtime); await viewer.start(); return { ...f, viewer };
}
describe('capability matrix', () => {
  it.each(['snapshot', 'ptz', 'recording', 'privacy', 'daynight', 'detection', 'refresh'] as Action[])('keeps unknown %s honest, allows explicit requests, and honors denials', action => {
    for (const knowledge of ['allowed', 'unknown', 'denied'] as Knowledge[]) {
      const access = availability(action, camera({ capabilities: { [action]: knowledge } }));
      expect(access.enabled).toBe(knowledge !== 'denied');
      if (knowledge === 'unknown') expect(access.reason).toContain('unverified');
    }
    expect(availability(action).enabled).toBe(false);
    expect(availability(action, camera(), new Set([action])).enabled).toBe(false);
  });
  it('does not confuse PTZ hardware with authorization', () => {
    expect(availability('ptz', camera({ ptz: 'denied' })).enabled).toBe(false);
    expect(availability('ptz', camera({ ptz: 'allowed', capabilities: {} })).reason).toContain('unverified');
  });
  it('has separate listen and talk requirements', () => {
    const snapshot = { state: 'playing' as const, transport: 'webrtc' as const, attempt: 0, talking: false, talk: { active: false, pending: false } };
    const c = config({ audio: { microphone: true, listen: false } });
    expect(audioAvailability('audio.listen', c, snapshot, caps, camera(), true).enabled).toBe(false);
    expect(audioAvailability('audio.talk', c, snapshot, caps, camera(), true).enabled).toBe(true);
    for (const transport of ['mse', 'hls'] as const) expect(audioAvailability('audio.talk', c, { ...snapshot, transport }, caps, camera(), true).enabled).toBe(false);
    expect(audioAvailability('audio.talk', c, snapshot, caps, camera(), false).enabled).toBe(false);
    expect(audioAvailability('audio.talk', c, snapshot, caps, camera({ backchannel: 'unknown' }), true).enabled).toBe(false);
    expect(audioAvailability('audio.talk', c, snapshot, caps, camera({ capabilities: { 'audio.talk': 'denied' } }), true).enabled).toBe(false);
    expect(audioAvailability('audio.talk', c, snapshot, { ...caps, audioDisabled: true }, camera(), true).enabled).toBe(false);
    expect(audioAvailability('audio.talk', config(), snapshot, caps, camera(), true).enabled).toBe(false);
  });
  it.each(['localhost', '127.0.0.1', '[::1]'])('allows secure same-origin HTTP loopback development only: %s', host => {
    vi.stubGlobal('location', new URL(`http://${host}:8123/dashboard`));
    const snapshot = { state: 'playing' as const, transport: 'webrtc' as const, attempt: 0, talking: false, talk: { active: false, pending: false } };
    const c = config({ server: `http://${host}:8123/nvr/`, audio: { microphone: true } });
    expect(audioAvailability('audio.talk', c, snapshot, caps, camera(), true).enabled).toBe(true);
    expect(audioAvailability('audio.talk', c, snapshot, caps, camera(), false).enabled).toBe(false);
    expect(audioAvailability('audio.talk', { ...c, server: `http://${host}:9000/` }, snapshot, caps, camera(), true).enabled).toBe(false);
    expect(audioAvailability('audio.talk', { ...c, server: 'http://nvr.example.test/' }, snapshot, caps, camera(), true).enabled).toBe(false);
  });
  it('scales each PTZ axis locally without sending speed', () => expect(scaledAxes({ x: -1, y: 1, z: .5, speed: .9 }, .2)).toEqual({ x: -.2, y: .2, z: .1 }));
  it('requires an explicit web UI URL and never invents timeline routes', () => {
    expect(viewerLink(config())).toBeUndefined();
    expect(viewerLink(config({ viewer_url: 'https://viewer.example.test/timeline/' }))).toBe('https://viewer.example.test/timeline/');
  });
});

describe('typed control requests', () => {
  it('never mutates a manual unknown camera, even with explicit source', async () => {
    const f = fixture(); vi.mocked(f.client.discover).mockResolvedValue([]);
    const viewer = new ViewerSession(config({ stream: 'front_door_sub', source: 'front_door_sub' }), document.createElement('video'), vi.fn(), f.runtime); await viewer.start();
    await viewer.mutate({ action: 'privacy', enabled: true }, () => true); viewer.startPtz({ x: 1 }, .5);
    expect(f.client.control).not.toHaveBeenCalled(); expect(f.client.mediaUrls).not.toHaveBeenCalled(); await viewer.dispose();
  });
  it.each(['recording', 'privacy', 'daynight', 'refresh', 'set-home', 'save-preset'])('requires shared-effect confirmation for %s', async action => {
    const { viewer, client } = await session();
    const request: ControlRequest = action === 'set-home' ? { action: 'ptz', command: action } : action === 'save-preset' ? { action: 'ptz', command: action, preset: 'owned' } : action === 'recording' || action === 'privacy' ? { action, enabled: true } : action === 'daynight' ? { action, mode: 'night' } : { action: 'refresh' };
    const confirm = vi.fn(() => false); await viewer.mutate(request, confirm);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('other viewers')); expect(client.control).not.toHaveBeenCalled(); expect(client.readControl).not.toHaveBeenCalled(); await viewer.dispose();
  });
  it('reads actual recording state before toggling and does not call accepted running', async () => {
    const { viewer, client } = await session();
    vi.mocked(client.readControl).mockResolvedValue({ recording: true }); vi.mocked(client.control).mockResolvedValue({ state: 'accepted', status: 202 });
    await viewer.mutate({ action: 'recording', enabled: true }, () => true);
    expect(client.control).toHaveBeenCalledWith('fixture', { action: 'recording', enabled: false }, expect.anything());
    expect(vi.mocked(client.readControl).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(client.control).mock.invocationCallOrder[0]!);
    expect(viewer.message).toContain('not yet confirmed'); await viewer.dispose();
  });
  it.each([401, 403])('never mutates after a denied read (%s)', async status => {
    const { viewer, client } = await session(); vi.mocked(client.readControl).mockRejectedValue(err(status));
    await viewer.mutate({ action: 'recording', enabled: true }, () => true);
    expect(client.control).not.toHaveBeenCalled(); expect(viewer.denied.has('recording')).toBe(true); expect(viewer.message).not.toContain('unsafe'); await viewer.dispose();
  });
  it('disables a rejected mutation instead of retrying or refreshing', async () => {
    const { viewer, client, playback } = await session(); vi.mocked(client.control).mockRejectedValue(err(403));
    await viewer.mutate({ action: 'daynight', mode: 'night' }, () => true);
    await viewer.mutate({ action: 'daynight', mode: 'day' }, () => true);
    expect(client.control).toHaveBeenCalledTimes(1); expect(playback.retry).not.toHaveBeenCalled(); await viewer.dispose();
  });
  it('stops media and stale detections during privacy changes', async () => {
    const { viewer, client, playback } = await session();
    vi.mocked(client.readControl).mockResolvedValueOnce({ privacy: false }).mockResolvedValueOnce({ privacy: true });
    viewer.toggleDetections(); await flush(); await viewer.mutate({ action: 'privacy', enabled: true }, () => true);
    expect(playback.stop).toHaveBeenCalled(); expect(viewer.detections).toEqual([]); expect(viewer.privateCamera).toBe(true); await viewer.dispose();
  });
  it('retains a real-client-like stop path until after delayed move ack on removal', async () => {
    const f = fixture(); const viewer = new ViewerSession(config(), document.createElement('video'), vi.fn(), f.runtime); await viewer.start();
    const move = deferred<{ state: 'applied' }>(); const events: string[] = [];
    vi.mocked(f.client.control).mockImplementation(async (_camera, request) => {
      if (f.disposed) throw new Error('Client disposed');
      if (request.action === 'ptz' && request.command === 'move') { await move.promise; events.push('move acknowledged'); }
      else events.push('stop');
      if (f.disposed) throw new Error('Client disposed');
      return { state: 'applied' };
    });
    viewer.startPtz({ x: 1 }, .2); const disposed = viewer.dispose(); await flush();
    expect(f.disposed).toBe(false); expect(events).toEqual(['stop']);
    move.resolve({ state: 'applied' }); await disposed;
    expect(events).toEqual(['stop', 'move acknowledged', 'stop']); expect(f.disposed).toBe(true);
  });
  it('bounds cleanup of a permanently pending move', async () => {
    vi.useFakeTimers(); const { viewer, client } = await session();
    vi.mocked(client.control).mockReturnValueOnce(new Promise(() => {})); viewer.startPtz({ z: 1 }, .5);
    const disposed = viewer.dispose(); await vi.advanceTimersByTimeAsync(2000); await disposed; expect(client.dispose).toHaveBeenCalledOnce();
  });
  it('changes the local speaker without stopping talk', async () => {
    const { viewer, playback } = await session(); viewer.startTalk(); vi.mocked(playback.stopTalk).mockClear();
    await viewer.speaker(); expect(playback.setListening).toHaveBeenCalledWith(true); expect(playback.stopTalk).not.toHaveBeenCalled(); await viewer.dispose();
  });
});

describe('snapshot and detection boundaries', () => {
  it.each([401, 403])('never falls through snapshot denial %s to canvas', async status => {
    const { viewer, client } = await session(); vi.mocked(client.authorizedFetch).mockRejectedValue(err(status)); const local = vi.fn();
    expect(await viewer.snapshotBlob(local)).toBeUndefined(); expect(local).not.toHaveBeenCalled(); await viewer.dispose();
  });
  it.each(['unknown', 'denied'] as const)('does not use canvas for %s permission', async knowledge => {
    const { viewer, client } = await session(camera({ capabilities: { snapshot: knowledge } })); vi.mocked(client.authorizedFetch).mockRejectedValue(err(404));
    const local = vi.fn(); await viewer.snapshotBlob(local); expect(local).not.toHaveBeenCalled(); await viewer.dispose();
  });
  it('uses canvas only after a known missing snapshot API with positive permission', async () => {
    const { viewer, client } = await session(); vi.mocked(client.authorizedFetch).mockRejectedValue(err(404));
    const blob = new Blob(['owned']); const local = vi.fn().mockResolvedValue(blob);
    expect(await viewer.snapshotBlob(local)).toBe(blob); expect(local).toHaveBeenCalledOnce(); await viewer.dispose();
  });
  it('honors tainted canvas restrictions without retrying another route', async () => {
    const video = document.createElement('video'); Object.defineProperties(video, { videoWidth: { value: 320 }, videoHeight: { value: 180 } });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(() => { throw new DOMException('Tainted', 'SecurityError'); });
    await expect(canvasSnapshot(video)).rejects.toThrow('origin policy');
  });
  it('blocks snapshot requests, canvas and detection polling for known privacy', async () => {
    const { viewer, client } = await session(camera({ privacy: true })); const local = vi.fn();
    await viewer.snapshotBlob(local); viewer.toggleDetections(); await flush();
    expect(client.authorizedFetch).not.toHaveBeenCalled(); expect(local).not.toHaveBeenCalled(); expect(client.detections).not.toHaveBeenCalled(); await viewer.dispose();
  });
  it('does not capture stale pixels if privacy becomes known during a request', async () => {
    const { viewer, client } = await session(); const response = deferred<Response>(); vi.mocked(client.authorizedFetch).mockReturnValue(response.promise);
    const local = vi.fn(); const pending = viewer.snapshotBlob(local); viewer.controlState = { privacy: true }; response.reject(err(404)); await pending;
    expect(local).not.toHaveBeenCalled(); await viewer.dispose();
  });
  it('polls without overlap, discards hidden results, and suspends even with continue video policy', async () => {
    vi.useFakeTimers(); const { viewer, client } = await session(camera(), { playback_visibility: { hidden: 'continue', offscreen: 'continue' } });
    const pending = deferred<readonly []>(); vi.mocked(client.detections).mockReturnValueOnce(pending.promise);
    viewer.toggleDetections(); await vi.advanceTimersByTimeAsync(5000); expect(client.detections).toHaveBeenCalledOnce();
    viewer.setVisible(false); pending.resolve([]); await flush(); await vi.advanceTimersByTimeAsync(5000); expect(client.detections).toHaveBeenCalledOnce();
    viewer.setVisible(true); await flush(); expect(client.detections).toHaveBeenCalledTimes(2);
    await viewer.dispose(); await vi.advanceTimersByTimeAsync(5000); expect(client.detections).toHaveBeenCalledTimes(2);
  });
  it('stops polling on permission failure and never mutates detection configuration', async () => {
    vi.useFakeTimers(); const { viewer, client } = await session(); vi.mocked(client.detections).mockRejectedValue(err(403)); viewer.toggleDetections();
    await vi.advanceTimersByTimeAsync(10000); expect(client.detections).toHaveBeenCalledOnce(); expect(client.control).not.toHaveBeenCalled(); expect(viewer.denied.has('detection')).toBe(true); await viewer.dispose();
  });
});

describe('late control/auth results', () => {
  it.each(['home', 'goto-preset'] as const)('tracks %s motion until interaction exit and delayed final stop', async command => {
    const f = fixture(); const viewer = new ViewerSession(config(), document.createElement('video'), vi.fn(), f.runtime); await viewer.start();
    const pending = deferred<{ state: 'applied' }>(); const events: string[] = [];
    vi.mocked(f.client.control).mockImplementation(async (_camera, request) => {
      if (f.disposed) throw new Error('Disposed');
      if (request.action === 'ptz' && request.command === command) { await pending.promise; events.push('motion'); } else events.push('stop');
      return { state: 'applied' };
    });
    const mutation = viewer.mutate(command === 'home' ? { action: 'ptz', command } : { action: 'ptz', command, preset: 'owned' }, () => true);
    const disposed = viewer.dispose(); await flush(); expect(f.disposed).toBe(false); pending.resolve({ state: 'applied' }); await Promise.all([mutation, disposed]);
    expect(events).toEqual(['stop', 'motion', 'stop']); expect(f.disposed).toBe(true);
  });
  it('does not let a superseded login overwrite a later challenge', async () => {
    const f = fixture(); const old = deferred<Awaited<ReturnType<typeof f.client.connect>>>(); vi.mocked(f.client.connect).mockReturnValueOnce(old.promise).mockResolvedValueOnce({ kind: 'totp-required', challenge: 'latest' });
    const viewer = new ViewerSession(config(), document.createElement('video'), vi.fn(), f.runtime);
    const first = viewer.start(); await viewer.start({ username: 'owned', password: 'owned' }); old.resolve({ kind: 'authenticated', mustChangePassword: false }); await first;
    expect(viewer.auth).toBe('totp'); expect(f.playback.start).not.toHaveBeenCalled(); await viewer.dispose();
  });
  it('blocks stale detection/snapshot when the controller reports privacy after cached discovery', async () => {
    const { viewer, client, emit } = await session(); emit({ state: 'denied', failure: { code: 'privacy', message: 'Camera privacy is enabled.' } });
    const local = vi.fn(); await viewer.snapshotBlob(local); viewer.toggleDetections(); await flush();
    expect(viewer.privateCamera).toBe(true); expect(client.authorizedFetch).not.toHaveBeenCalled(); expect(local).not.toHaveBeenCalled(); expect(client.detections).not.toHaveBeenCalled(); await viewer.dispose();
  });
});

describe('bounded local resources', () => {
  it('bounds snapshot data before retaining an oversized body', async () => {
    const { readSnapshot } = await import('../../../src/ui/controls'); const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1)); }, cancel }), { headers: { 'Content-Type': 'image/jpeg' } });
    await expect(readSnapshot(response, new AbortController().signal)).rejects.toMatchObject({ failure: { code: 'buffer' } }); expect(cancel).toHaveBeenCalledOnce();
  });
  it('cancels snapshot readers on removal and deadline', async () => {
    const { readSnapshot } = await import('../../../src/ui/controls'); vi.useFakeTimers();
    const cancel = vi.fn(); const abort = new AbortController();
    const pending = readSnapshot(new Response(new ReadableStream({ cancel })), abort.signal); const cancelled = expect(pending).rejects.toMatchObject({ failure: { code: 'cancelled' } }); abort.abort(); await cancelled; expect(cancel).toHaveBeenCalledOnce();
    const timeoutCancel = vi.fn(); const timeout = readSnapshot(new Response(new ReadableStream({ cancel: timeoutCancel })), new AbortController().signal);
    const rejected = expect(timeout).rejects.toMatchObject({ failure: { code: 'timeout' } }); await vi.advanceTimersByTimeAsync(10000); await rejected; expect(timeoutCancel).toHaveBeenCalledOnce();
  });
  it('does not apply a late microphone failure after gesture release', async () => {
    const { viewer, playback } = await session(); const permission = deferred<void>(); vi.mocked(playback.startTalk).mockReturnValue(permission.promise);
    viewer.startTalk(); viewer.stopTalk(); permission.reject(err(403)); await flush(); expect(viewer.denied.has('audio.talk')).toBe(false); await viewer.dispose();
  });
  it('permits a new explicit microphone gesture after a no-device failure', async () => {
    const { viewer, playback } = await session(); vi.mocked(playback.startTalk).mockRejectedValueOnce(new NvrError({ code: 'unsupported-api', message: '' }));
    viewer.startTalk(); await flush(); viewer.startTalk(); expect(playback.startTalk).toHaveBeenCalledTimes(2); await viewer.dispose();
  });
});

describe('confirmed privacy resumption', () => {
  it('uses fresh privacy state after a confirmed unprivacy action instead of stale inventory', async () => {
    const { viewer, client } = await session(camera({ privacy: true }));
    vi.mocked(client.readControl).mockResolvedValueOnce({ privacy: true }).mockResolvedValueOnce({ privacy: false });
    await viewer.mutate({ action: 'privacy', enabled: false }, () => true);
    expect(viewer.privateCamera).toBe(false); expect(await viewer.snapshotBlob()).toBeInstanceOf(Blob); expect(client.authorizedFetch).toHaveBeenCalledOnce(); await viewer.dispose();
  });
});


describe('confirmed timeline deep links', () => {
  const now = new Date(2026, 10, 10, 7, 8, 9);
  it('requires an explicit viewer_url even with a known canonical camera', () => {
    expect(timelineLink(config(), camera(), now)).toBeUndefined();
  });
  it.each(['https://viewer.example.test/nvr/front/', 'https://viewer.example.test/nvr/front'])('preserves the explicit web root subpath: %s', viewer_url => {
    const url = new URL(timelineLink(config({ viewer_url, source: 'rtsp://private.invalid/raw', stream: 'selector' }), camera({ name: 'canonical & #/? ü' }), now)!);
    expect(url.pathname).toBe('/nvr/front/timeline.html');
    expect(url.searchParams.get('stream')).toBe('canonical & #/? ü');
    expect(url.searchParams.get('date')).toBe('2026-11-10'); expect(url.searchParams.get('time')).toBe('07:08:09');
    expect(url.href).not.toContain('private.invalid'); expect(url.searchParams.has('fullscreen')).toBe(false);
    expect(url.href).toContain('stream=canonical%20%26%20%23%2F%3F%20%C3%BC');
  });
  it('resolves an explicit same-origin web root separately from the API proxy and includes fullscreen hints', () => {
    const url = new URL(timelineLink(config({ server: '/api-only/front/', viewer_url: '/viewer/front/' }), camera(), now, true, 'https://ha.example.test/dashboard/view')!);
    expect(url.origin).toBe('https://ha.example.test'); expect(url.pathname).toBe('/viewer/front/timeline.html');
    expect(url.searchParams.get('fullscreen')).toBe('1'); expect(url.searchParams.get('nav')).toBe('fine');
  });
  it('keeps manual sources with no canonical camera on the explicit root only', () => {
    const c = config({ viewer_url: 'https://viewer.example.test/web/', source: 'rtsp://private.invalid/raw', stream: 'front_door_sub' });
    expect(timelineLink(c, undefined, now, true)).toBe('https://viewer.example.test/web/');
  });
  it('uses local calendar/time components across UTC date boundaries', () => {
    const local = new Date('2026-11-10T00:30:45Z');
    vi.spyOn(local, 'getFullYear').mockReturnValue(2026); vi.spyOn(local, 'getMonth').mockReturnValue(10); vi.spyOn(local, 'getDate').mockReturnValue(9);
    vi.spyOn(local, 'getHours').mockReturnValue(16); vi.spyOn(local, 'getMinutes').mockReturnValue(30); vi.spyOn(local, 'getSeconds').mockReturnValue(45);
    const url = new URL(timelineLink(config({ viewer_url: 'https://viewer.example.test/' }), camera(), local)!);
    expect(url.searchParams.get('date')).toBe('2026-11-09'); expect(url.searchParams.get('time')).toBe('16:30:45');
  });
});
