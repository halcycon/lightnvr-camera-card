import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateConfig, NvrError, type NvrClient, type ControlRequest } from '../../../src/contracts';
import { createClientFactory, normalizeProfile, safeDiagnostic } from '../../../src/api';
const origin = 'https://dashboard.example.invalid/lovelace';
const config = (extra = {}) => validateConfig({type:'custom:lightnvr-camera-card',server:'/nvr/front',stream:'fixture',...extra});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const clients: NvrClient[] = [];
afterEach(() => clients.splice(0).forEach(c => c.dispose()));
function fixture(handler: (url:URL,init:RequestInit) => Response | Promise<Response>, options = {}) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(new URL(String(input)),init ?? {}));
  const factory = createClientFactory({fetch:fetch as typeof globalThis.fetch,documentUrl:origin});
  const client = factory(config(options)); clients.push(client); return {client,fetch};
}

describe('URL and authority boundaries', () => {
  it.each([['https://nvr.example.invalid','https://nvr.example.invalid/'],['/nvr/front','https://dashboard.example.invalid/nvr/front/'],['/','https://dashboard.example.invalid/']])('normalizes %s', (server,expected) => {
    const result = normalizeProfile(config({server}),origin);
    expect(result.baseUrl).toBe(expected); expect(result.go2rtcUrl).toBe(expected+'go2rtc/');
  });
  it('preserves configured proxy prefix for every media URL and omits native HLS for unmapped manual sources', () => {
    const {client} = fixture(() => json({}));
    const result = client.mediaUrls({source:'literal_sub?&',camera:'fixture',profile:'main'},false);
    for (const [kind,value] of Object.entries(result)) {
      const url = new URL(value); expect(url.pathname).toMatch(/^\/nvr\/front\//);
      expect(url.username).toBe(''); expect(url.password).toBe('');
      if (kind !== 'nativeHls') { expect(url.searchParams.get('src')).toBe('literal_sub?&'); expect(url.searchParams.has('audio')).toBe(false); expect(url.searchParams.has('video')).toBe(kind === 'go2rtcHls'); }
    }
    expect(result.mse.startsWith('wss:')).toBe(true);
    expect(result.nativeHls).toBeUndefined();
    expect(new URL(result.go2rtcHls).searchParams.get('mp4')).toBe('flac');
    expect(client.mediaUrls({source:'manual',profile:'main'},true).nativeHls).toBeUndefined();
  });
  it.each(['https://foreign.example.invalid/x','//foreign.invalid/x','/api/streams','../api/streams','go2rtc/api/../streams','go2rtc/api/%2e%2e/streams','go2rtc/api/%252e%252e/streams','go2rtc/api/%5cstreams','go2rtc/api/streams','api/settings','go2rtc/api/config'])('rejects unsafe/admin authorizedFetch path %s', async path => {
    const {client,fetch} = fixture(() => json({})); await expect(client.authorizedFetch(path)).rejects.toBeInstanceOf(NvrError); expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects redirects and ignores caller-provided Authorization/Cookie headers', async () => {
    const {client,fetch} = fixture(() => {
      const response = new Response('redirect target'); Object.defineProperty(response,'redirected',{value:true}); return response;
    });
    await expect(client.authorizedFetch('go2rtc/api/frame.jpeg?src=fixture',{headers:{Authorization:'Bearer fixture',Cookie:'fixture'}})).rejects.toMatchObject({failure:{code:'proxy'}});
    const init = fetch.mock.calls[0]?.[1]; expect(init?.redirect).toBe('error'); expect(new Headers(init?.headers).has('Authorization')).toBe(false); expect(new Headers(init?.headers).has('Cookie')).toBe(false);
  });
  it('allows prefixed HLS children with credential-bound query bytes intact', async () => {
    const {client,fetch} = fixture(() => new Response('owned fixture bytes'));
    const response = await client.authorizedFetch('go2rtc/api/hls/playlist.m3u8?id=generated%2Bfixture');
    expect(await response.text()).toBe('owned fixture bytes');
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://dashboard.example.invalid/nvr/front/go2rtc/api/hls/playlist.m3u8?id=generated%2Bfixture');
  });
  it('rejects username-only/session-only config conflicting with a cookie identity', async () => {
    const {client,fetch} = fixture(() => json({authenticated:true,username:'other-fixture-user',role:'viewer'}),{username:'expected-fixture-user',credential_storage:'session'});
    await expect(client.connect()).rejects.toMatchObject({failure:{code:'configuration'}}); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['dial tcp fixture.invalid: connect: connection refused','dial tcp fixture.invalid: no route to host','connect: network is unreachable'])('classifies bounded go2rtc offline errors safely (%s)', async text => {
    const {client} = fixture(() => new Response(text,{status:500,headers:{'Content-Type':'text/plain'}}));
    try { await client.authorizedFetch('go2rtc/api/webrtc?src=fixture',{method:'POST',body:'generated-offer'}); throw new Error('expected failure'); }
    catch (error) {expect(safeDiagnostic(error)).toEqual({code:'source-offline',message:'Source is offline.',status:500}); expect(JSON.stringify(error)).not.toContain(text);}
  });
  it.each([401,403])('does not infer offline or bypass a denial from body text (%s)', async status => {
    const {client} = fixture(() => new Response('dial tcp: connection refused',{status}));
    await expect(client.authorizedFetch('go2rtc/api/webrtc?src=fixture',{method:'POST'})).rejects.toMatchObject({failure:{code:status === 401 ? 'auth' : 'policy',status}});
  });
  it('caps upstream error-body inspection and cancels the remainder', async () => {
    const cancel = vi.fn();
    const {client} = fixture(() => new Response(new ReadableStream({start(c) {c.enqueue(new TextEncoder().encode('x'.repeat(4096)+'dial tcp: private'));},cancel}),{status:500,headers:{'Content-Type':'text/plain'}}));
    await expect(client.authorizedFetch('go2rtc/api/webrtc?src=fixture',{method:'POST'})).rejects.toMatchObject({failure:{code:'proxy'}});
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('typed control wire adaptation', () => {
  const cases: [ControlRequest,string,string,unknown,number][] = [
    [{action:'ptz',command:'move',axes:{x:.4,z:-.2}},'/ptz/move','POST',{pan:.4,zoom:-.2},200],
    [{action:'ptz',command:'absolute',axes:{y:.5}},'/ptz/absolute','POST',{tilt:.5},200],
    [{action:'ptz',command:'relative',axes:{z:.1}},'/ptz/relative','POST',{zoom:.1},200],
    [{action:'ptz',command:'stop'},'/ptz/stop','POST',{},200],
    [{action:'ptz',command:'home'},'/ptz/home','POST',{},200],
    [{action:'ptz',command:'set-home'},'/ptz/set-home','POST',{},200],
    [{action:'ptz',command:'goto-preset',preset:'token'},'/ptz/goto-preset','POST',{token:'token'},200],
    [{action:'ptz',command:'save-preset',preset:'name'},'/ptz/preset','PUT',{name:'name'},200],
    [{action:'daynight',mode:'night'},'/daynight','POST',{mode:'night'},200],
    [{action:'recording',enabled:true},'/recording','POST',{action:'start'},202],
    [{action:'recording',enabled:false},'/recording','POST',{action:'stop'},200],
    [{action:'privacy',enabled:true},'','PUT',{set_privacy_mode:true},200],
    [{action:'refresh'},'/refresh','POST',{},202],
  ];
  it.each(cases)('adapts %j to the canonical upstream route', async (request,suffix,method,body,status) => {
    const {client,fetch} = fixture(() => json({success:true},status));
    const result = await client.control('fixture camera',request);
    expect(result).toEqual(status === 202 ? {state:'accepted',status:202} : {state:'applied'});
    expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe('/nvr/front/api/streams/fixture%20camera'+suffix);
    const init = fetch.mock.calls[0]?.[1]; expect(init?.method).toBe(method); expect(JSON.parse(String(init?.body))).toEqual(body);
  });
  it('never replays a denied or expired mutation', async () => {
    const {client,fetch} = fixture(() => json({},401));
    await expect(client.control('fixture',{action:'ptz',command:'stop'})).rejects.toMatchObject({failure:{code:'auth'}}); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects unsupported speed and non-finite axes before network I/O', async () => {
    const {client,fetch} = fixture(() => json({}));
    for (const axes of [{x:1,speed:.5},{x:Infinity},{}]) await expect(client.control('fixture',{action:'ptz',command:'move',axes})).rejects.toMatchObject({failure:{code:'configuration'}});
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reads confirmed recording state rather than treating 202 as active', async () => {
    const {client} = fixture(() => json({recording_active:false,state:'starting'}));
    expect(await client.readControl('fixture','recording')).toEqual({recording:false});
  });
  it('adapts PTZ presets and strips the private device-service URL', async () => {
    const {client} = fixture(url => url.pathname.endsWith('/capabilities') ? json({has_pan_tilt:true,has_zoom:false,ptz_service_url:'private'}) : json({presets:[{token:'id',name:'Fixture'}]}));
    expect(await client.readControl('fixture','ptz')).toEqual({ptz:{pan:true,tilt:true,zoom:false},presets:[{id:'id',name:'Fixture'}]});
  });
  it('adapts detections and rejects malformed coordinates', async () => {
    let valid = true;
    const {client} = fixture(url => {expect(url.pathname).toBe('/nvr/front/api/detection/results/fixture'); return json({detections:[{x:valid ? .1 : 'bad',y:.2,width:.3,height:.4,label:'owned fixture',confidence:.9,private:'omitted'}]});});
    expect(await client.detections('fixture')).toEqual([{x:.1,y:.2,width:.3,height:.4,label:'owned fixture',confidence:.9}]);
    valid = false; await expect(client.detections('fixture')).rejects.toMatchObject({failure:{code:'unsupported-api'}});
  });
});

describe('media profile and cancellation boundaries', () => {
  it('does not substitute a native main playlist for a selected sub or exact manual source', () => {
    const {client} = fixture(() => json({}));
    expect(client.mediaUrls({camera:'fixture',source:'fixture_sub',profile:'sub'},true).nativeHls).toBeUndefined();
    expect(client.mediaUrls({camera:'fixture',source:'exact_manual',profile:'main'},true).nativeHls).toBeUndefined();
    expect(client.mediaUrls({camera:'literal_sub',source:'literal_sub',profile:'main'},true).nativeHls).toBe('https://dashboard.example.invalid/nvr/front/hls/literal_sub/index.m3u8');
  });
  it('cancels an authorized response body after headers', async () => {
    const cancel = vi.fn(), abort = new AbortController();
    const {client} = fixture(() => new Response(new ReadableStream({cancel})));
    const response = await client.authorizedFetch('go2rtc/api/hls/init.mp4?id=generated',{signal:abort.signal});
    const read = response.arrayBuffer(); const rejection = expect(read).rejects.toMatchObject({failure:{code:'cancelled'}});
    abort.abort(); await rejection; expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('control acknowledgement validation', () => {
  it.each([{success:false,error:'sensitive upstream detail'},{error:'sensitive upstream detail'}])('does not report an applied command for a malformed 200 response', async body => {
    const {client} = fixture(() => json(body));
    await expect(client.control('fixture',{action:'ptz',command:'stop'})).rejects.toMatchObject({failure:{code:'unsupported-api'}});
  });
});
