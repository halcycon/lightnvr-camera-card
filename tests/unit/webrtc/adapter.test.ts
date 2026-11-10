import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebRtcAdapter, type WebRtcOptions } from '../../../src/transports/webrtc';
import { createTalkController } from '../../../src/audio';
import type { CameraSummary, TransportAdapter, TransportStart } from '../../../src/contracts';
import { deferred, fixture, flush, Peer, Stream, Track } from './fakes';
const adapters: TransportAdapter[] = [];
function setup(options: WebRtcOptions = {}, overrides: Partial<TransportStart> = {}) {
  const f = fixture(overrides); const peers: Peer[] = [];
  const createPeer = vi.fn((config: RTCConfiguration) => { void config; const peer = new Peer(); peers.push(peer); return peer.asPeer(); });
  const adapter = createWebRtcAdapter({ createPeerConnection: createPeer, createMediaStream: () => new Stream().asStream(), documentUrl: 'https://dashboard.example.test/lovelace/view', ...options });
  adapters.push(adapter); return { ...f, peers, createPeer, adapter };
}
const camera: CameraSummary = { name: 'generated', sources: { main: 'generated' }, status: 'online', privacy: false, capabilities: { 'audio.listen': 'allowed', 'audio.talk': 'allowed', 'live.view': 'allowed' }, backchannel: 'allowed', ptz: 'denied' };
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.stop())); vi.useRealTimers(); vi.restoreAllMocks(); });
describe('HTTP SDP negotiation', () => {
  it.each([200, 201])('accepts SDP %i and uses only an authorized POST with exact source and gathered offer', async status => {
    const s = setup(); s.client.authorizedFetch.mockResolvedValueOnce(new Response('v=0\r\ns=generated\r\n', { status, headers: { 'Content-Type': 'application/sdp; charset=utf-8' } }));
    await s.adapter.start(s.context);
    expect(s.createPeer).toHaveBeenCalledWith(expect.objectContaining({ iceServers: [{ urls: 'stun:owned.example.test:3478' }] }));
    expect(s.client.authorizedFetch).toHaveBeenCalledOnce();
    expect(s.client.authorizedFetch).toHaveBeenCalledWith('go2rtc/api/webrtc?src=literal_sub', expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp' }, body: 'v=0\r\ns=generated-offer\r\n', signal: expect.any(AbortSignal) }));
    expect(s.peers[0]!.transceivers.map(t => [t.kind, t.direction])).toEqual([['video', 'recvonly'], ['audio', 'recvonly']]);
    expect(s.events).not.toContainEqual({ type: 'first-frame', transport: 'webrtc' }); expect(s.adapter.getAudioSender?.()).toBeUndefined();
  });
  it('uses an explicit ICE override including empty list without calling the server', async () => {
    const s = setup(); s.context.config.ice_servers = [];
    await s.adapter.start(s.context); expect(s.client.iceServers).not.toHaveBeenCalled(); expect(s.createPeer.mock.calls[0]![0].iceServers).toEqual([]);
  });
  it('preserves TURN configuration without exposing credentials in events', async () => {
    const s = setup(); s.context.config.ice_servers = [{ urls: 'turn:owned.example.test:3478', username: 'generated', credential: 'generated-secret' }];
    await s.adapter.start(s.context); expect(s.createPeer.mock.calls[0]![0].iceServers).toEqual(s.context.config.ice_servers); expect(JSON.stringify(s.events)).not.toContain('generated-secret');
  });
  it('does not invent public STUN when server ICE is unavailable', async () => {
    const s = setup(); s.client.iceServers.mockRejectedValueOnce(new Error('private server text'));
    await expect(s.adapter.start(s.context)).rejects.toMatchObject({ failure: { code: 'network' } }); expect(s.createPeer).not.toHaveBeenCalled();
  });
  it('waits for complete ICE and posts updated local SDP', async () => {
    const peer = new Peer(); peer.iceGatheringState = 'gathering'; const s = setup({ createPeerConnection: () => peer.asPeer() });
    const start = s.adapter.start(s.context); await flush(); expect(s.client.authorizedFetch).not.toHaveBeenCalled(); peer.gather(); await start;
    expect(s.client.authorizedFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: 'v=0\r\ns=generated-complete-candidates\r\n' }));
  });
  it('bounds gathering and sends the current candidates without an HTTP candidate endpoint', async () => {
    vi.useFakeTimers(); const peer = new Peer(); peer.iceGatheringState = 'gathering'; const s = setup({ createPeerConnection: () => peer.asPeer(), iceGatheringTimeoutMs: 100 });
    const start = s.adapter.start(s.context); await flush(); await vi.advanceTimersByTimeAsync(100); await start;
    expect(s.client.authorizedFetch).toHaveBeenCalledTimes(1); expect(s.client.authorizedFetch.mock.calls[0]![0]).toContain('api/webrtc?');
  });
  it('abort during gathering prevents any SDP request', async () => {
    const peer = new Peer(); peer.iceGatheringState = 'gathering'; const s = setup({ createPeerConnection: () => peer.asPeer() });
    const result = s.adapter.start(s.context).catch(error => error); await flush(); s.abort.abort();
    expect(await result).toMatchObject({ failure: { code: 'cancelled' } }); expect(peer.close).toHaveBeenCalledOnce(); expect(s.client.authorizedFetch).not.toHaveBeenCalled(); expect(s.events).toEqual([]);
  });
  it('ignores stale ICE config results after overlapping starts', async () => {
    const s = setup(), oldIce = deferred<RTCIceServer[]>(); s.client.iceServers.mockReturnValueOnce(oldIce.promise);
    const first = s.adapter.start(s.context).catch(error => error); await s.adapter.start(s.context); oldIce.resolve([]); await first; await flush();
    expect(s.createPeer).toHaveBeenCalledOnce(); expect(s.client.authorizedFetch).toHaveBeenCalledOnce();
  });
  it.each([401, 403])('preserves HTTP %i denial without retries', async status => {
    const s = setup(); s.client.authorizedFetch.mockResolvedValueOnce(new Response('private response', { status }));
    await expect(s.adapter.start(s.context)).rejects.toMatchObject({ failure: { code: status === 401 ? 'auth' : 'policy', status } });
    expect(s.client.authorizedFetch).toHaveBeenCalledOnce(); expect(s.peers[0]!.close).toHaveBeenCalledOnce();
  });
  it('preserves source-offline errors classified by the API', async () => {
    const s = setup(); const { NvrError } = await import('../../../src/contracts');
    s.client.authorizedFetch.mockRejectedValueOnce(new NvrError({ code: 'source-offline', message: 'Source is offline.' }));
    await expect(s.adapter.start(s.context)).rejects.toMatchObject({ failure: { code: 'source-offline' } });
  });
  it.each([['text/html', '<html>private proxy text</html>'], ['application/sdp', 'invalid private SDP']])('rejects invalid response %s safely', async (type, body) => {
    const s = setup(); s.client.authorizedFetch.mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'Content-Type': type } }));
    await expect(s.adapter.start(s.context)).rejects.toMatchObject({ failure: { code: 'unsupported-api' } }); expect(JSON.stringify(s.events)).not.toContain('private');
  });
  it('rejects an oversized streamed SDP body and cancels it', async () => {
    const s = setup(); const cancel = vi.fn();
    s.client.authorizedFetch.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel }), { status: 201, headers: { 'content-type': 'application/sdp' } }));
    await expect(s.adapter.start(s.context)).rejects.toMatchObject({ failure: { code: 'unsupported-api' } }); expect(cancel).toHaveBeenCalledOnce();
  });
  it.each(['abort', 'timeout'] as const)('%s while SDP body is incomplete cancels the reader and closes peer', async action => {
    vi.useFakeTimers(); const s = setup(), cancel = vi.fn();
    s.client.authorizedFetch.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('v=0\r\n')); }, cancel }), { status: 201, headers: { 'content-type': 'application/sdp' } }));
    const result = s.adapter.start(s.context).catch(error => error); await flush();
    if (action === 'abort') s.abort.abort(); else await vi.advanceTimersByTimeAsync(500);
    expect(await result).toMatchObject({ failure: { code: action === 'abort' ? 'cancelled' : 'timeout' } }); expect(cancel).toHaveBeenCalledOnce(); expect(s.peers[0]!.setRemoteDescription).not.toHaveBeenCalled(); expect(s.peers[0]!.close).toHaveBeenCalledOnce();
  });
  it('body cancellation settles even when the underlying cancel promise never resolves', async () => {
    const s = setup(), cancel = vi.fn(() => new Promise<void>(() => {}));
    s.client.authorizedFetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 201, headers: { 'content-type': 'application/sdp' } }));
    const result = s.adapter.start(s.context).catch(error => error); await flush(); s.abort.abort();
    expect(await result).toMatchObject({ failure: { code: 'cancelled' } }); expect(cancel).toHaveBeenCalledOnce();
  });
  it('aborts non-cooperative remote description and keeps it away from a replacement session', async () => {
    const s = setup(), pending = deferred<void>(), peer = new Peer(); peer.setRemoteDescription.mockReturnValueOnce(pending.promise);
    const adapter = createWebRtcAdapter({ createPeerConnection: () => peer.asPeer(), createMediaStream: () => new Stream().asStream() }); adapters.push(adapter);
    const result = adapter.start(s.context).catch(error => error); await flush(); await adapter.stop();
    expect(await result).toMatchObject({ failure: { code: 'cancelled' } }); pending.resolve(); await flush(); expect(s.video.play).not.toHaveBeenCalled(); expect(adapter.getAudioSender?.()).toBeUndefined();
  });
  it('cancels a late response from a stale non-cooperative fetch', async () => {
    const s = setup(), pending = deferred<Response>(), cancel = vi.fn(); s.client.authorizedFetch.mockReturnValueOnce(pending.promise);
    const result = s.adapter.start(s.context).catch(error => error); await flush(); await s.adapter.stop(); await result;
    pending.resolve(new Response(new ReadableStream({ cancel }), { status: 201, headers: { 'content-type': 'application/sdp' } })); await flush(); expect(cancel).toHaveBeenCalledOnce();
  });
  it('TLS/network diagnostics identify HA document and NVR signaling origins without private paths', async () => {
    const s = setup({ documentUrl: 'https://ha.example.test/lovelace/private' }); s.client.authorizedFetch.mockRejectedValueOnce(new TypeError('private raw network details'));
    await expect(s.adapter.start(s.context)).rejects.toMatchObject({ failure: { code: 'network', message: expect.stringContaining('HA document origin: https://ha.example.test; NVR signaling origin: https://dashboard.example.test') } });
    const message = JSON.stringify(s.events); expect(message).not.toContain('literal_sub'); expect(message).not.toContain('private'); expect(message).not.toContain('generated-offer');
  });
  it('applies preferences only to supported codecs and retains repair codecs', async () => {
    const codecs = [{ mimeType: 'video/VP8', clockRate: 90000 }, { mimeType: 'video/rtx', clockRate: 90000 }, { mimeType: 'video/H264', clockRate: 90000 }];
    const s = setup({ receiverCapabilities: kind => kind === 'video' ? { codecs, headerExtensions: [] } : null }); await s.adapter.start(s.context);
    expect(s.peers[0]!.transceivers[0]!.setCodecPreferences).toHaveBeenCalledWith([codecs[2], codecs[0], codecs[1]]);
  });
});
describe('separate audio policy and negotiation', () => {
  it.each([
    [true, true, false, 'allowed', 'allowed', 'recvonly'],
    [true, false, false, 'allowed', 'allowed', undefined],
    [true, false, true, 'allowed', 'allowed', 'sendonly'],
    [true, true, true, 'allowed', 'allowed', 'sendrecv'],
    [true, false, true, 'denied', 'allowed', undefined],
    [true, true, true, 'allowed', 'denied', 'recvonly'],
    [false, true, true, 'allowed', 'allowed', undefined],
  ] as const)('policy audio=%s listen=%s talk=%s backchannel=%s talk-grant=%s -> %s', async (enabled, listen, microphone, backchannel, grant, expected) => {
    const s = setup({}, { camera: { ...camera, backchannel, capabilities: { ...camera.capabilities, 'audio.talk': grant } } });
    Object.assign(s.context.config.audio, { enabled, listen, microphone }); await s.adapter.start(s.context);
    expect(s.peers[0]!.transceivers.find(t => t.kind === 'audio')?.direction).toBe(expected);
    expect(Boolean(s.adapter.getAudioSender?.())).toBe(expected === 'sendrecv' || expected === 'sendonly');
    expect(s.video.muted).toBe(true);
  });
  it('server audio disabled overrides all card audio intent', async () => {
    const s = setup({}, { camera }); s.context.capabilities.audioDisabled = true; Object.assign(s.context.config.audio, { listen: true, microphone: true, muted: false });
    await s.adapter.start(s.context); expect(s.peers[0]!.transceivers.map(t => t.kind)).toEqual(['video']); expect(s.adapter.getAudioSender?.()).toBeUndefined(); expect(s.video.muted).toBe(true);
    await expect(s.adapter.setListening(true)).rejects.toMatchObject({ failure: { code: 'policy' } }); expect(s.createPeer).toHaveBeenCalledOnce();
  });
  it('listen denial does not disable authorized talk or video', async () => {
    const s = setup({}, { camera: { ...camera, capabilities: { ...camera.capabilities, 'audio.listen': 'denied' } } }); s.context.config.audio.microphone = true;
    await s.adapter.start(s.context); expect(s.peers[0]!.transceivers[1]!.direction).toBe('sendonly'); expect(s.adapter.getAudioSender?.()).toBeDefined();
  });
  it('initial default mute clears on explicit speaker gesture with no renegotiation', async () => {
    const s = setup(); await s.adapter.start(s.context); expect(s.video.muted).toBe(true);
    await s.adapter.setListening(true); expect(s.video.muted).toBe(false); expect(s.createPeer).toHaveBeenCalledOnce(); expect(s.client.authorizedFetch).toHaveBeenCalledOnce();
  });
  it('rejects local unmute when config did not negotiate receiving audio', async () => {
    const s = setup(); s.context.config.audio.listen = false; await s.adapter.start(s.context);
    await expect(s.adapter.setListening(true)).rejects.toMatchObject({ failure: { code: 'policy' } }); expect(s.video.muted).toBe(true); expect(s.createPeer).toHaveBeenCalledOnce();
  });
  it('local mute is distinct from listen negotiation and volume', async () => {
    const s = setup(); s.context.config.audio.muted = false; s.context.config.audio.volume = 0.3;
    await s.adapter.start(s.context); expect(s.video.muted).toBe(false); expect(s.video.volume).toBe(0.3); expect(s.peers[0]!.transceivers[1]!.direction).toBe('recvonly');
  });
  it('local speaker mute/unmute preserves the negotiated sender and active microphone', async () => {
    const s = setup({}, { camera }); s.context.config.audio.microphone = true;
    await s.adapter.start(s.context); const first = s.peers[0]!; const track = new Track(); const acquire = vi.fn(async () => new Stream([track.asTrack()]).asStream());
    const talk = createTalkController({ isSecureContext: () => true, getUserMedia: acquire, createMeter: () => () => {} });
    await talk.start(s.adapter.getAudioSender!()!, new AbortController().signal);
    const sender = s.adapter.getAudioSender!();
    await s.adapter.setListening(false); expect(s.video.muted).toBe(true);
    expect(first.close).not.toHaveBeenCalled(); expect(track.stop).not.toHaveBeenCalled(); expect(talk.state.active).toBe(true);
    await s.adapter.setListening(true); expect(s.video.muted).toBe(false);
    expect(s.adapter.getAudioSender!()).toBe(sender); expect(first.transceivers[1]!.direction).toBe('sendrecv');
    expect(s.createPeer).toHaveBeenCalledOnce(); expect(acquire).toHaveBeenCalledOnce(); await talk.dispose();
  });
  it.each(['policy', 'privacy', 'source-offline'] as const)('blocks %s before signaling', async code => {
    const s = setup({}, { camera: code === 'privacy' ? { ...camera, privacy: true } : code === 'source-offline' ? { ...camera, status: 'offline' } : { ...camera, capabilities: { 'live.view': 'denied' } } });
    await expect(s.adapter.start(s.context)).rejects.toMatchObject({ failure: { code } }); expect(s.client.authorizedFetch).not.toHaveBeenCalled();
  });
});
describe('decoded video and peer lifecycle', () => {
  it('ICE connected and metadata never establish first frame; decoded video emits once', async () => {
    const s = setup(); await s.adapter.start(s.context); const peer = s.peers[0]!;
    peer.ice('connected'); s.video.dispatchEvent(new Event('loadedmetadata')); s.video.dispatchEvent(new Event('playing'));
    expect(s.events).toEqual([]); s.video.decoded(); s.video.decoded();
    expect(s.events).toEqual([{ type: 'first-frame', transport: 'webrtc' }]);
  });
  it('uses rendered video-frame callbacks when available and cancels them on stop', async () => {
    const s = setup(); let callback!: VideoFrameRequestCallback;
    const request = vi.fn((fn: VideoFrameRequestCallback) => { callback = fn; return 1; }); const cancel = vi.fn();
    Object.assign(s.video, { requestVideoFrameCallback: request, cancelVideoFrameCallback: cancel });
    await s.adapter.start(s.context);
    callback(0, { width: 640, height: 360, presentedFrames: 1 } as VideoFrameCallbackMetadata);
    expect(s.events).toEqual([{ type: 'first-frame', transport: 'webrtc' }]); await s.adapter.stop(); expect(cancel).toHaveBeenCalledWith(1);
  });
  it('times out without decoded video even when ICE succeeds', async () => {
    vi.useFakeTimers(); const s = setup(); await s.adapter.start(s.context); s.peers[0]!.ice('connected'); await vi.advanceTimersByTimeAsync(500);
    expect(s.events).toContainEqual({ type: 'failure', failure: { code: 'timeout', message: expect.any(String) } }); expect(s.peers[0]!.close).toHaveBeenCalledOnce();
  });
  it('keeps a decoded peer beyond the connection deadline and ignores retired events', async () => {
    vi.useFakeTimers(); const s = setup(); await s.adapter.start(s.context); s.video.decoded(); await vi.advanceTimersByTimeAsync(600); expect(s.peers[0]!.close).not.toHaveBeenCalled();
    await s.adapter.start(s.context); const count = s.events.length; s.peers[0]!.ice('failed'); s.peers[0]!.track(new Track('video')); expect(s.events).toHaveLength(count);
  });
  it('ICE grace recovers then permits explicit talk without automatic capture', async () => {
    vi.useFakeTimers(); const s = setup({}, { camera }); s.context.config.audio.microphone = true; await s.adapter.start(s.context); s.video.decoded();
    const tracks: Track[] = []; const acquire = vi.fn(async () => { const track = new Track(); tracks.push(track); return new Stream([track.asTrack()]).asStream(); });
    const meterStop = vi.fn(); const talk = createTalkController({ isSecureContext: () => true, getUserMedia: acquire, createMeter: () => meterStop }); const signal = new AbortController().signal;
    await talk.start(s.adapter.getAudioSender!()!, signal); s.peers[0]!.ice('disconnected'); await flush();
    expect(tracks[0]!.stop).toHaveBeenCalled(); expect(meterStop).toHaveBeenCalledOnce(); expect(talk.state.active).toBe(false); expect(s.adapter.getAudioSender?.()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(50); s.peers[0]!.ice('connected'); await vi.advanceTimersByTimeAsync(150);
    expect(acquire).toHaveBeenCalledOnce(); expect(talk.state.active).toBe(false); expect(s.peers[0]!.close).not.toHaveBeenCalled();
    await talk.start(s.adapter.getAudioSender!()!, signal); expect(acquire).toHaveBeenCalledTimes(2); expect(talk.state.active).toBe(true); await talk.dispose();
  });
  it('replacement peer cancels pending permission; only an explicit fresh gesture can attach', async () => {
    const s = setup({}, { camera }); s.context.config.audio.microphone = true; await s.adapter.start(s.context);
    const pending = deferred<MediaStream>(), late = new Track(), fresh = new Track();
    const acquire = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(new Stream([fresh.asTrack()]).asStream());
    const talk = createTalkController({ isSecureContext: () => true, getUserMedia: acquire, createMeter: () => () => {} });
    const oldSender = s.adapter.getAudioSender!()!; const start = talk.start(oldSender, new AbortController().signal);
    await s.adapter.start(s.context); await start; pending.resolve(new Stream([late.asTrack()]).asStream()); await flush();
    expect(late.stop).toHaveBeenCalledOnce(); expect(oldSender.replaceTrack).not.toHaveBeenCalled(); expect(s.adapter.getAudioSender!()!.replaceTrack).not.toHaveBeenCalled();
    await talk.start(s.adapter.getAudioSender!()!, new AbortController().signal); expect(s.adapter.getAudioSender!()!.replaceTrack).toHaveBeenCalledWith(fresh.asTrack()); await talk.dispose();
  });
  it('persistent ICE disconnect fails after grace; terminal failure closes immediately', async () => {
    vi.useFakeTimers(); const s = setup(); await s.adapter.start(s.context); s.video.decoded(); s.peers[0]!.ice('disconnected'); s.peers[0]!.ice('disconnected');
    await vi.advanceTimersByTimeAsync(99); expect(s.peers[0]!.close).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1); expect(s.peers[0]!.close).toHaveBeenCalledOnce();
    expect(s.events).toContainEqual({ type: 'failure', failure: { code: 'ice', message: expect.any(String) } });
    await s.adapter.start(s.context); s.peers[1]!.ice('failed'); expect(s.peers[1]!.close).toHaveBeenCalledOnce();
  });
  it('remote video end is offline; audio end leaves video alive', async () => {
    const s = setup(); await s.adapter.start(s.context); const audio = new Track(), video = new Track('video'); s.peers[0]!.track(audio); s.peers[0]!.track(video); s.video.decoded();
    audio.end(); expect(s.peers[0]!.close).not.toHaveBeenCalled(); video.end();
    expect(s.events).toContainEqual({ type: 'failure', failure: { code: 'source-offline', message: expect.any(String) } }); expect(s.video.srcObject).toBeNull();
  });
  it('stop revokes active capture, remote tracks, video and all timers; repeat-safe', async () => {
    vi.useFakeTimers(); const s = setup({}, { camera }); s.context.config.audio.microphone = true; await s.adapter.start(s.context);
    const local = new Track(), remote = new Track('video'); s.peers[0]!.track(remote);
    const stopMeter = vi.fn(); const talk = createTalkController({ isSecureContext: () => true, getUserMedia: async () => new Stream([local.asTrack()]).asStream(), createMeter: () => stopMeter });
    await talk.start(s.adapter.getAudioSender!()!, new AbortController().signal); await s.adapter.stop(); await s.adapter.stop(); await flush();
    expect(local.readyState).toBe('ended'); expect(remote.readyState).toBe('ended'); expect(stopMeter).toHaveBeenCalledOnce(); expect(s.video.srcObject).toBeNull(); expect(vi.getTimerCount()).toBe(0); await talk.dispose();
  });
  it('autoplay denial cancels deadline and resumes only on explicit listening/play gesture', async () => {
    vi.useFakeTimers(); const s = setup(); s.video.play.mockRejectedValueOnce(new DOMException('needs gesture', 'NotAllowedError'));
    await s.adapter.start(s.context); await flush(); await vi.advanceTimersByTimeAsync(600);
    expect(s.events).toEqual([{ type: 'failure', failure: { code: 'autoplay', message: 'Playback needs a user gesture.' } }]);
    expect(s.peers[0]!.close).not.toHaveBeenCalled(); await s.adapter.setListening(true); s.video.decoded(); expect(s.createPeer).toHaveBeenCalledOnce(); expect(s.video.play).toHaveBeenCalledTimes(2);
    expect(s.events.at(-1)).toEqual({ type: 'first-frame', transport: 'webrtc' });
  });
  it('a video-only explicit play gesture clears autoplay suspension without enabling listen', async () => {
    const s = setup(); s.context.config.audio.listen = false; s.video.play.mockRejectedValueOnce(new DOMException('needs gesture', 'NotAllowedError'));
    await s.adapter.start(s.context); await flush(); expect(s.events.at(-1)).toMatchObject({ type: 'failure', failure: { code: 'autoplay' } });
    // The controller retries the retained video.play(); the browser then reports playing.
    await s.video.play(); s.video.decoded();
    expect(s.events.at(-1)).toEqual({ type: 'first-frame', transport: 'webrtc' }); expect(s.createPeer).toHaveBeenCalledOnce();
    expect(s.peers[0]!.transceivers.map(t => t.kind)).toEqual(['video']);
  });
  it('polls only safe stats and requires decoded video, then ignores stale stats', async () => {
    vi.useFakeTimers(); const onStats = vi.fn(); const s = setup({ onStats, statsIntervalMs: 100 }); await s.adapter.start(s.context); const peer = s.peers[0]!;
    peer.getStats.mockResolvedValue(new Map([['generated', { type: 'inbound-rtp', kind: 'video', framesDecoded: 2, bytesReceived: 123, packetsLost: 1, privateAddress: 'private' }]]));
    s.video.readyState = 2; s.video.videoWidth = 640; await vi.advanceTimersByTimeAsync(100);
    expect(onStats).toHaveBeenCalledWith({ framesDecoded: 2, bytesReceived: 123, packetsLost: 1 }); expect(JSON.stringify(onStats.mock.calls)).not.toContain('private');
    expect(s.events).toContainEqual({ type: 'first-frame', transport: 'webrtc' }); await s.adapter.stop(); const count = onStats.mock.calls.length; await vi.advanceTimersByTimeAsync(200); expect(onStats).toHaveBeenCalledTimes(count);
  });
});
