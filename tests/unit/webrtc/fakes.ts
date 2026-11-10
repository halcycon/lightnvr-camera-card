import { vi } from 'vitest';
import { validateConfig, type NvrClient, type TransportEvent, type TransportStart } from '../../../src/contracts';
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
export class Track extends EventTarget {
  enabled = true; readyState = 'live';
  stop = vi.fn(() => { this.readyState = 'ended'; });
  constructor(readonly kind = 'audio') { super(); }
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
  asTrack() { return this as unknown as MediaStreamTrack; }
}
export class Stream {
  constructor(readonly tracks: MediaStreamTrack[] = []) {}
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  addTrack(t: MediaStreamTrack) { this.tracks.push(t); }
  removeTrack(t: MediaStreamTrack) { this.tracks.splice(this.tracks.indexOf(t), 1); }
  asStream() { return this as unknown as MediaStream; }
}
export class Sender {
  track: MediaStreamTrack | null = null;
  replaceTrack = vi.fn(async (track: MediaStreamTrack | null) => { this.track = track; });
  asSender() { return this as unknown as RTCRtpSender; }
}
export class Video extends EventTarget {
  srcObject: MediaStream | null = null; autoplay = false; playsInline = false; muted = true; volume = 1;
  readyState = 0; videoWidth = 0; videoHeight = 0;
  play = vi.fn(async () => {}); pause = vi.fn();
  asVideo() { return this as unknown as HTMLVideoElement; }
  decoded() { this.readyState = 2; this.videoWidth = 640; this.videoHeight = 360; this.dispatchEvent(new Event('playing')); }
}
export class Peer extends EventTarget {
  iceGatheringState = 'complete'; iceConnectionState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  transceivers: { kind: string; direction: RTCRtpTransceiverDirection; currentDirection: RTCRtpTransceiverDirection | null; sender: RTCRtpSender; setCodecPreferences: ReturnType<typeof vi.fn> }[] = [];
  close = vi.fn(() => { this.iceConnectionState = 'closed'; });
  createOffer = vi.fn(async (): Promise<RTCSessionDescriptionInit> => ({ type: 'offer', sdp: 'v=0\r\ns=generated-offer\r\n' }));
  setLocalDescription = vi.fn(async (offer: RTCSessionDescriptionInit) => { this.localDescription = offer; });
  setRemoteDescription = vi.fn(async (answer: RTCSessionDescriptionInit) => {
    void answer;
    for (const t of this.transceivers) t.currentDirection = t.direction;
  });
  getStats = vi.fn(async () => new Map());
  addTransceiver(kind: string, init: RTCRtpTransceiverInit) {
    const t = { kind, direction: init.direction!, currentDirection: null as RTCRtpTransceiverDirection | null, sender: new Sender().asSender(), setCodecPreferences: vi.fn() };
    this.transceivers.push(t); return t as unknown as RTCRtpTransceiver;
  }
  getSenders() { return this.transceivers.map(t => t.sender); }
  asPeer() { return this as unknown as RTCPeerConnection; }
  ice(state: string) { this.iceConnectionState = state; this.dispatchEvent(new Event('iceconnectionstatechange')); }
  gather() { this.iceGatheringState = 'complete'; this.localDescription = { type: 'offer', sdp: 'v=0\r\ns=generated-complete-candidates\r\n' }; this.dispatchEvent(new Event('icegatheringstatechange')); }
  track(track: Track) { const event = Object.assign(new Event('track'), { track: track.asTrack(), streams: [] }); this.dispatchEvent(event); }
}
export function fixture(overrides: Partial<TransportStart> = {}) {
  const video = new Video();
  const events: TransportEvent[] = [];
  const abort = new AbortController();
  const client = {
    profile: { baseUrl: 'https://dashboard.example.test/nvr/', origin: 'https://dashboard.example.test' },
    iceServers: vi.fn(async (): Promise<RTCIceServer[]> => [{ urls: 'stun:owned.example.test:3478' }]),
    mediaUrls: vi.fn(() => ({ webrtc: 'https://dashboard.example.test/nvr/go2rtc/api/webrtc?src=literal_sub' })),
    authorizedFetch: vi.fn(async (path: string, init?: RequestInit) => { void path; void init; return new Response('v=0\r\ns=generated-answer\r\n', { status: 201, headers: { 'content-type': 'application/sdp' } }); }),
  };
  const context: TransportStart = {
    video: video.asVideo(), source: { source: 'literal_sub', profile: 'main' },
    capabilities: { go2rtc: 'allowed', forceNativeHls: false, audioDisabled: false, transports: { webrtc: 'allowed', mse: 'allowed', hls: 'allowed' } },
    client: client as unknown as NvrClient,
    config: validateConfig({ type: 'custom:lightnvr-camera-card', server: '/nvr/', stream: 'literal_sub', timeouts: { connection_ms: 500, ice_grace_ms: 100 } }),
    signal: abort.signal, emit: event => events.push(event), ...overrides,
  };
  return { video, client, events, abort, context };
}
