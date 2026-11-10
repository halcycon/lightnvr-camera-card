import { NvrError, type PlaybackFailure, type TransportAdapter, type TransportStart } from '../../contracts';
import { registerSender, senderIsValid } from '../../audio/sender-lease';
import { abortable, cancellation, gatherIce } from './ice';

export interface WebRtcStats {
  framesDecoded: number; bytesReceived: number; packetsLost: number; roundTripTime?: number;
}
export interface WebRtcOptions {
  createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
  createMediaStream?: () => MediaStream;
  receiverCapabilities?: (kind: 'video' | 'audio') => RTCRtpCapabilities | null;
  iceGatheringTimeoutMs?: number;
  statsIntervalMs?: number;
  onStats?: (stats: Readonly<WebRtcStats>) => void;
  documentUrl?: string;
}
interface Session {
  context: TransportStart; cancel: AbortController; cleanups: (() => void)[];
  peer?: RTCPeerConnection; stream?: MediaStream; audio?: RTCRtpTransceiver;
  revoke?: () => void; deadline?: ReturnType<typeof setTimeout>; grace?: ReturnType<typeof setTimeout>;
  stats?: ReturnType<typeof setInterval>; frame?: number; first: boolean; blocked: boolean;
  ready: boolean; listen: boolean; talk: boolean; failure?: PlaybackFailure; closed: boolean;
}
const fail = (code: PlaybackFailure['code'], message: string, status?: number) =>
  new NvrError({ code, message, ...(status === undefined ? {} : { status }) });
const direction = (listen: boolean, talk: boolean): RTCRtpTransceiverDirection => talk ? (listen ? 'sendrecv' : 'sendonly') : (listen ? 'recvonly' : 'inactive');

/** Keep the response body within the session deadline and bound memory use. */
async function readAnswer(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw fail('unsupported-api', 'The signaling endpoint returned an empty SDP answer.');
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    for (;;) {
      const part = await abortable(reader.read(), signal);
      if (part.done) return text + decoder.decode();
      bytes += part.value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw fail('unsupported-api', 'The signaling endpoint returned an oversized SDP answer.');
      text += decoder.decode(part.value, { stream: true });
    }
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Independently implemented against the pinned lightNVR HTTP-SDP contract. */
export function createWebRtcAdapter(options: WebRtcOptions = {}): TransportAdapter {
  let session: Session | undefined;
  const live = (s: Session) => session === s && !s.closed && !s.cancel.signal.aborted;
  function close(s: Session) {
    if (s.closed) return;
    s.closed = true;
    s.cancel.abort();
    clearTimeout(s.deadline); clearTimeout(s.grace); clearInterval(s.stats);
    s.cleanups.splice(0).forEach(fn => fn());
    if (s.frame !== undefined) s.context.video.cancelVideoFrameCallback?.(s.frame);
    // Revocation stops capture synchronously before the peer can be replaced.
    s.revoke?.();
    s.peer?.getSenders().forEach(sender => sender.track?.stop());
    s.peer?.close();
    s.stream?.getTracks().forEach(track => track.stop());
    if (s.stream && s.context.video.srcObject === s.stream) {
      s.context.video.pause(); s.context.video.srcObject = null;
    }
  }
  const emitFailure = (s: Session, failure: PlaybackFailure) => {
    if (!live(s) || s.failure) return;
    s.failure = Object.freeze({ ...failure });
    close(s);
    s.context.emit({ type: 'failure', failure: s.failure });
  };
  function firstFrame(s: Session) {
    if (!live(s) || s.first || s.blocked) return;
    s.first = true;
    clearTimeout(s.deadline);
    s.context.emit({ type: 'first-frame', transport: 'webrtc' });
  }
  function watchFrames(s: Session) {
    const video = s.context.video;
    // A successful playing event also covers T6's explicit video-only play gesture.
    const resumed = () => {
      if (!live(s) || !s.blocked) return;
      s.blocked = false;
      if (s.first) s.context.emit({ type: 'state', state: 'playing' });
    };
    video.addEventListener('playing', resumed);
    s.cleanups.push(() => video.removeEventListener('playing', resumed));
    const rendered = () => {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) firstFrame(s);
    };
    if (typeof video.requestVideoFrameCallback === 'function') {
      const next: VideoFrameRequestCallback = (_time, metadata) => {
        if (!live(s)) return;
        if (metadata.width > 0 && metadata.height > 0 && metadata.presentedFrames > 0) firstFrame(s);
        if (!s.first) s.frame = video.requestVideoFrameCallback(next);
      };
      s.frame = video.requestVideoFrameCallback(next);
    } else {
      video.addEventListener('playing', rendered);
      video.addEventListener('timeupdate', rendered);
      s.cleanups.push(() => { video.removeEventListener('playing', rendered); video.removeEventListener('timeupdate', rendered); });
    }
  }
  function play(s: Session) {
    void s.context.video.play().catch(cause => {
      if (!live(s)) return;
      if (cause instanceof Error && cause.name === 'NotAllowedError') {
        s.blocked = true;
        clearTimeout(s.deadline);
        s.context.emit({ type: 'failure', failure: { code: 'autoplay', message: 'Playback needs a user gesture.' } });
      } else emitFailure(s, { code: 'unsupported-codec', message: 'WebRTC video playback failed.' });
    });
  }
  function applyCodecs(transceiver: RTCRtpTransceiver, kind: 'video' | 'audio') {
    const caps = options.receiverCapabilities?.(kind) ?? globalThis.RTCRtpReceiver?.getCapabilities?.(kind);
    if (!caps?.codecs.length || !transceiver.setCodecPreferences) return;
    // Reorder only browser-advertised codecs; preserve repair codecs and every supported fallback.
    const preference = kind === 'video' ? ['video/h264', 'video/vp8', 'video/vp9'] : ['audio/opus', 'audio/pcmu', 'audio/pcma'];
    const codecs = [...caps.codecs].sort((a, b) => {
      const rank = (mime: string) => { const i = preference.indexOf(mime.toLowerCase()); return i < 0 ? preference.length : i; };
      return rank(a.mimeType) - rank(b.mimeType);
    });
    try { transceiver.setCodecPreferences(codecs); } catch { /* Some browsers expose a partial preferences API. */ }
  }
  function monitor(s: Session) {
    let pending = false;
    s.stats = setInterval(() => {
      if (!live(s) || !s.peer || pending) return;
      pending = true;
      void s.peer.getStats().then(reports => {
        if (!live(s)) return;
        let framesDecoded = 0, bytesReceived = 0, packetsLost = 0;
        let roundTripTime: number | undefined;
        reports.forEach(report => {
          const number = (key: string) => typeof report[key] === 'number' && Number.isFinite(report[key]) ? Math.max(0, report[key] as number) : 0;
          if (report.type === 'inbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')) {
            framesDecoded += number('framesDecoded'); bytesReceived += number('bytesReceived'); packetsLost += number('packetsLost');
          }
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) roundTripTime = number('currentRoundTripTime');
        });
        // Stats prove decoding, never ICE/bytes alone. No candidate addresses or SDP leave this module.
        if (framesDecoded > 0 && s.context.video.readyState >= 2 && s.context.video.videoWidth > 0) firstFrame(s);
        try { options.onStats?.(Object.freeze({ framesDecoded, bytesReceived, packetsLost, ...(roundTripTime === undefined ? {} : { roundTripTime }) })); } catch { /* Optional observer. */ }
      }).catch(() => {}).finally(() => { pending = false; });
    }, options.statsIntervalMs ?? 1000);
  }
  function signalingFailure(s: Session, cause: unknown): PlaybackFailure {
    if (cause instanceof NvrError && cause.failure.code !== 'network') return cause.failure;
    let origin = 'unavailable';
    try { origin = new URL(options.documentUrl ?? globalThis.location?.href ?? '').origin; } catch { /* Non-browser test context. */ }
    // Only origins are intentionally shown for TLS diagnosis: never source, query, credentials or upstream text.
    return { code: 'network', message: `WebRTC SDP signaling failed. HA document origin: ${origin}; NVR signaling origin: ${s.context.client.profile.origin}. Check TLS trust, mixed content, proxy and browser connectivity.` };
  }
  async function start(context: TransportStart): Promise<void> {
    if (session) close(session);
    const s: Session = { context, cancel: new AbortController(), cleanups: [], first: false, blocked: false, ready: false, listen: false, talk: false, closed: false };
    session = s;
    const externalAbort = () => close(s);
    context.signal.addEventListener('abort', externalAbort, { once: true });
    s.cleanups.push(() => context.signal.removeEventListener('abort', externalAbort));
    if (context.signal.aborted) { close(s); throw cancellation(); }
    const { config, capabilities, camera, video, client } = context;
    const timeout = config.timeouts.webrtc_ms ?? (config.timeouts.connection_ms === 'inherit' ? capabilities.connectionTimeoutMs ?? 30000 : config.timeouts.connection_ms);
    s.deadline = setTimeout(() => emitFailure(s, { code: 'timeout', message: 'WebRTC did not decode a video frame before the connection deadline.' }), timeout);
    try {
      if (capabilities.go2rtc === 'denied' || capabilities.transports.webrtc === 'denied') throw fail('policy', 'WebRTC is disabled by server policy.');
      if (camera?.privacy === true) throw fail('privacy', 'Camera privacy is enabled.');
      if (camera?.capabilities['live.view'] === 'denied') throw fail('policy', 'Live viewing is denied.');
      if (camera?.status === 'offline' || camera?.status === 'disabled') throw fail('source-offline', 'Source is offline.');
      if (!options.createPeerConnection && !globalThis.RTCPeerConnection) throw fail('unsupported-api', 'WebRTC is unavailable in this browser.');
      const audio = config.audio.enabled && capabilities.audioDisabled !== true;
      s.listen = audio && config.audio.listen && camera?.capabilities['audio.listen'] !== 'denied';
      // Unknown grants remain subject to server authorization; never override an explicit denial.
      s.talk = audio && config.audio.microphone && camera?.backchannel !== 'denied' && camera?.capabilities['audio.talk'] !== 'denied';
      const iceServers = config.ice_servers ?? await abortable(client.iceServers({ signal: s.cancel.signal }), s.cancel.signal);
      if (!live(s)) throw cancellation();
      const peer = (options.createPeerConnection ?? (configuration => new RTCPeerConnection(configuration)))({ iceServers: iceServers.map(server => ({ urls: server.urls, ...(server.username === undefined ? {} : { username: server.username }), ...(server.credential === undefined ? {} : { credential: server.credential }) })), iceCandidatePoolSize: 0, bundlePolicy: 'max-bundle' });
      s.peer = peer;
      s.stream = (options.createMediaStream ?? (() => new MediaStream()))();
      video.srcObject = s.stream; video.autoplay = true; video.playsInline = true;
      video.muted = config.audio.muted || !s.listen; video.volume = config.audio.volume;
      watchFrames(s);
      const videoTransceiver = peer.addTransceiver('video', { direction: 'recvonly' });
      applyCodecs(videoTransceiver, 'video');
      if (s.listen || s.talk) {
        s.audio = peer.addTransceiver('audio', { direction: direction(s.listen, s.talk) });
        applyCodecs(s.audio, 'audio');
        if (s.talk) s.revoke = registerSender(s.audio.sender, () => live(s) && s.ready && (s.audio?.currentDirection === 'sendrecv' || s.audio?.currentDirection === 'sendonly'));
      }
      const track = (event: RTCTrackEvent) => {
        if (!live(s)) { event.track.stop(); return; }
        if (event.track.kind === 'audio' && !s.listen) event.track.enabled = false;
        if (!s.stream!.getTracks().includes(event.track)) s.stream!.addTrack(event.track);
        const ended = () => {
          if (!live(s)) return;
          if (event.track.kind === 'video') emitFailure(s, { code: 'source-offline', message: 'The remote video track ended.' });
          else { s.stream?.removeTrack(event.track); event.track.enabled = false; }
        };
        event.track.addEventListener('ended', ended, { once: true });
        s.cleanups.push(() => event.track.removeEventListener('ended', ended));
      };
      const ice = () => {
        if (!live(s)) return;
        const state = peer.iceConnectionState;
        if (state === 'failed' || state === 'closed') emitFailure(s, { code: 'ice', message: 'WebRTC media connection failed.' });
        else if (state === 'disconnected') {
          if (s.grace !== undefined) return;
          // Talk is never resumed automatically after an ICE interruption.
          s.revoke?.();
          context.emit({ type: 'state', state: 'recovering' });
          s.grace = setTimeout(() => emitFailure(s, { code: 'ice', message: 'WebRTC media connection did not recover within the ICE grace period.' }), config.timeouts.ice_grace_ms);
        } else if (state === 'connected' || state === 'completed') {
          if (s.grace !== undefined && s.audio && s.talk) {
            s.revoke = registerSender(s.audio.sender, () => live(s) && s.ready && (s.audio?.currentDirection === 'sendrecv' || s.audio?.currentDirection === 'sendonly'));
          }
          clearTimeout(s.grace); delete s.grace;
          if (s.first) context.emit({ type: 'state', state: 'playing' });
        }
      };
      peer.addEventListener('track', track); peer.addEventListener('iceconnectionstatechange', ice);
      s.cleanups.push(() => { peer.removeEventListener('track', track); peer.removeEventListener('iceconnectionstatechange', ice); });
      const offer = await abortable(peer.createOffer(), s.cancel.signal);
      await abortable(peer.setLocalDescription(offer), s.cancel.signal);
      await gatherIce(peer, s.cancel.signal, options.iceGatheringTimeoutMs ?? 1000);
      if (!live(s)) throw cancellation();
      const localSdp = peer.localDescription?.sdp;
      if (!localSdp) throw fail('unsupported-api', 'WebRTC did not produce a local SDP offer.');
      const media = client.mediaUrls(context.source, s.listen).webrtc;
      const base = client.profile.baseUrl;
      if (!media.startsWith(base)) throw fail('configuration', 'WebRTC signaling must stay within the authenticated NVR scope.');
      const response = await abortable(client.authorizedFetch(media.slice(base.length), { method: 'POST', headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp' }, body: localSdp, signal: s.cancel.signal }).then(response => {
        if (!live(s)) { void response.body?.cancel().catch(() => {}); throw cancellation(); }
        return response;
      }), s.cancel.signal);
      if (response.status !== 200 && response.status !== 201) {
        void response.body?.cancel().catch(() => {});
        throw fail(response.status === 401 ? 'auth' : response.status === 403 ? 'policy' : 'proxy', 'WebRTC SDP request was rejected.', response.status);
      }
      if (!/^application\/sdp(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        void response.body?.cancel().catch(() => {});
        throw fail('unsupported-api', 'The signaling endpoint did not return a supported SDP answer.');
      }
      const body = await readAnswer(response, s.cancel.signal);
      if (!/^v=0\r?\n/.test(body)) throw fail('unsupported-api', 'The signaling endpoint did not return a supported SDP answer.');
      await abortable(peer.setRemoteDescription({ type: 'answer', sdp: body }), s.cancel.signal);
      if (!live(s)) throw cancellation();
      s.ready = true;
      monitor(s); play(s);
    } catch (cause) {
      if (s.failure) throw new NvrError(s.failure);
      if (!live(s)) throw cancellation();
      const failure = signalingFailure(s, cause);
      emitFailure(s, failure);
      throw new NvrError(failure);
    }
  }
  return {
    kind: 'webrtc', start,
    async stop() { if (session) close(session); session = undefined; },
    getAudioSender() {
      const s = session;
      return s && live(s) && s.ready && s.talk && s.audio && senderIsValid(s.audio.sender) && (s.audio?.currentDirection === 'sendrecv' || s.audio?.currentDirection === 'sendonly') ? s.audio.sender : undefined;
    },
    async setListening(enabled) {
      const s = session;
      if (!s || !live(s)) return;
      // config.audio.listen controls SDP receive permission; this is a local speaker gesture.
      if (enabled && !s.listen) throw fail('policy', 'Listening was not enabled or permitted for this WebRTC session.');
      s.context.video.muted = !enabled;
      if (enabled) {
        s.blocked = false;
        play(s);
      }
    },
  };
}
