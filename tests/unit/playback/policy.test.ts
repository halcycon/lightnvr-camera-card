import { afterEach, describe, expect, it, vi } from 'vitest';
import { transportAvailable } from '../../../src/playback/policy';
import { mockClient, Video } from './fixture';

afterEach(() => vi.unstubAllGlobals());
describe('known renderer exclusions', () => {
  it('skips missing browser WebRTC/MSE APIs and accepts native HLS', () => {
    vi.stubGlobal('window', {}); vi.stubGlobal('RTCPeerConnection', undefined); vi.stubGlobal('MediaSource', undefined);
    const api = mockClient(), video = new Video(); video.canPlayType.mockReturnValue('probably');
    expect(transportAvailable('webrtc', api.settings, api.asClient(), video.asVideo())).toBe(false);
    expect(transportAvailable('mse', api.settings, api.asClient(), video.asVideo())).toBe(false);
    expect(transportAvailable('hls', api.settings, api.asClient(), video.asVideo())).toBe(true);
  });
  it('filters the proven cross-origin/Basic MSE limitation before attempting WS', () => {
    const api = mockClient(), video = new Video(); api.client.profile.sameOrigin = false;
    expect(transportAvailable('mse', api.settings, api.asClient(), video.asVideo())).toBe(false);
    api.client.profile.sameOrigin = true; api.client.profile.auth = 'basic';
    expect(transportAvailable('mse', api.settings, api.asClient(), video.asVideo())).toBe(false);
    expect(transportAvailable('webrtc', api.settings, api.asClient(), video.asVideo())).toBe(true);
  });
});
