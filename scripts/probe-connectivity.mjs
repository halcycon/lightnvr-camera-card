import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { startProxy } from '../tests/probes/proxy.mjs';
const research='8983888a19fef2040c48eee0a4ce56db5dafeb85';
const tested='4e578c1dac4a21688b420c8fc852f741d62efd2e';
if (!process.env.LIGHTNVR_PROBE_FIXTURE) {
  console.error('INCOMPLETE: real isolated lightNVR fixture absent. Run node tests/probes/setup-fixture.mjs, then set LIGHTNVR_PROBE_FIXTURE to its private /tmp descriptor. Mocks cannot verify protocol compatibility.');
  process.exit(2);
}
const fixture=JSON.parse(await readFile(process.env.LIGHTNVR_PROBE_FIXTURE,'utf8'));
const u=new URL(fixture.origin);
if(u.hostname!=='127.0.0.1'||u.protocol!=='http:'||u.username||u.password||u.pathname!=='/')throw new Error('Only isolated loopback HTTP fixture allowed');
const container=JSON.parse(execFileSync('podman',['inspect',fixture.container],{encoding:'utf8'}))[0];
const image=JSON.parse(execFileSync('podman',['image','inspect',container.Image],{encoding:'utf8'}))[0];
if(image.Labels['org.opencontainers.image.revision']!==tested || !container.State.Running)throw new Error('Fixture image revision/runtime not verified');
if(container.Config.Labels?.['io.lightnvr-card.fixture']!=='T1' || !container.NetworkSettings.Ports['8080/tcp']?.some(p=>p.HostIp==='127.0.0.1'&&p.HostPort===u.port))throw new Error('Descriptor must match a T1-labelled fixture loopback port');
const proxy=await startProxy(fixture.origin);
let browser;
const report={research,tested,imageDigest:image.Digest,browser:'',checks:[],status:'incomplete'};
function check(name,passed,evidence={}){report.checks.push({name,passed:Boolean(passed),...evidence});if(!passed)throw new Error(`Probe assertion failed: ${name}`);}
try {
 browser=await chromium.launch({headless:true,...(process.env.LIGHTNVR_CHROMIUM?{executablePath:process.env.LIGHTNVR_CHROMIUM}:{} )});
 report.browser=browser.version();
 const context=await browser.newContext();const page=await context.newPage();
 const cdp=await context.newCDPSession(page); await cdp.send('Network.enable');
 const handshakes=[];const preflights=[];const methods=new Map();
 cdp.on('Network.requestWillBeSent',e=>methods.set(e.requestId,e.request.method));
 cdp.on('Network.responseReceived',e=>{if(methods.get(e.requestId)==='OPTIONS')preflights.push({method:'OPTIONS',endpoint:new URL(e.response.url).pathname,status:e.response.status,contentType:e.response.mimeType});});
 cdp.on('Network.webSocketHandshakeResponseReceived',e=>handshakes.push({status:e.response.status,contentType:e.response.headers['Content-Type']??e.response.headers['content-type']??null}));
 cdp.on('Network.webSocketFrameError',e=>{const status=e.errorMessage.match(/Unexpected response code: (\d+)/)?.[1];if(status)handshakes.push({status:Number(status),contentType:null});});
 page.on('console',e=>{const status=e.text().match(/WebSocket handshake: Unexpected response code: (\d+)/)?.[1];if(status)handshakes.push({status:Number(status),contentType:null,via:'browser-console-status-only'});});
 // Seed a valid cookie by logging in from the NVR origin, then attempt WS from HA.
 // A fresh cookie jar below keeps this direct-topology root cookie out of proxy tests.
 await page.goto(fixture.origin+'api/auth/verify');
 const directLogin=await page.evaluate(async f=>(await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:f.username,password:f.password})})).ok,fixture);
 check('directOriginCookieLogin',directLogin);
 await page.goto(proxy.origin);
 const directWsAuthenticated=await page.evaluate(f=>new Promise(resolve=>{
   const w=new WebSocket(f.origin.replace('http:','ws:')+'go2rtc/api/ws?src='+encodeURIComponent(f.source));
   const timer=setTimeout(()=>{w.close();resolve(false);},5000);
   w.onopen=()=>{clearTimeout(timer);w.close();resolve(true);};w.onerror=()=>{clearTimeout(timer);resolve(false);};
 }),fixture);
 await context.clearCookies();
 const result=await page.evaluate(async f=>{
  const observations=[];
  const fetchSafe=async(label,url,options={})=>{try{const r=await fetch(url,options);observations.push({label,status:r.status,contentType:r.headers.get('content-type')});return r;}catch{return null;}};
  const creds=JSON.stringify({username:f.username,password:f.password});
  const direct=await fetchSafe('direct-login',f.origin+'api/auth/login',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:creds});
  const basic=await fetchSafe('basic-inventory',f.origin+'api/streams?summary=true&surface=live&page=1&page_size=100&sort_by=name&sort_order=asc&availability=all',{credentials:'omit',headers:{Authorization:'Basic '+btoa(f.username+':'+f.password)}});
  const basicOk=basic?.ok;
  const root='/lightnvr/front/';
  const proxyBasic=await fetchSafe('proxy-basic-inventory',root+'api/streams?summary=true&surface=live&page=1&page_size=100&sort_by=name&sort_order=asc&availability=all',{credentials:'omit',headers:{Authorization:'Basic '+btoa(f.username+':'+f.password)}});
  const login=await fetchSafe('proxy-login',root+'api/auth/login',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:creds});
  const body=login?await login.json():{};
  const inventory=await fetchSafe('proxy-inventory',root+'api/streams?summary=true&surface=live&page=1&page_size=100&sort_by=name&sort_order=asc&availability=all');
  const inv=inventory?await inventory.json():{};
  const ws=async(url)=>new Promise(resolve=>{const w=new WebSocket(url);const timer=setTimeout(()=>{w.close();resolve(false);},5000);w.onopen=()=>{clearTimeout(timer);w.close();resolve(true);};w.onerror=()=>{clearTimeout(timer);resolve(false);};});
  const proxyWs=await ws(location.origin.replace('http:','ws:')+root+'go2rtc/api/ws?src='+encodeURIComponent(f.source));
  const pc=new RTCPeerConnection({iceServers:[]});pc.addTransceiver('video',{direction:'recvonly'});
  await pc.setLocalDescription(await pc.createOffer());
  await Promise.race([new Promise(resolve=>{if(pc.iceGatheringState==='complete')resolve();else pc.onicegatheringstatechange=()=>{if(pc.iceGatheringState==='complete')resolve();};}),new Promise(resolve=>setTimeout(resolve,2000))]);
  const answer=await fetchSafe('proxy-sdp',root+'go2rtc/api/webrtc?src='+encodeURIComponent(f.source),{method:'POST',headers:{'Content-Type':'application/sdp'},body:pc.localDescription.sdp});
  const sdp=answer?await answer.text():'';let sdpValid=/^v=0[\r\n]/.test(sdp)&&answer?.headers.get('content-type')==='application/sdp';
  try{await pc.setRemoteDescription({type:'answer',sdp});}catch{sdpValid=false;}finally{pc.close();}
  const master=await fetchSafe('proxy-hls-master',root+'go2rtc/api/stream.m3u8?src='+encodeURIComponent(f.source)+'&mp4=flac');
  const text=master?await master.text():'';const child=text.split('\n').find(v=>v.trim()&&!v.startsWith('#'))?.trim();
  let childOk=false,segmentOk=false,initOk=false,scoped=false,anonymousChildDenied=false;
  if(child){scoped=child.startsWith(root);const media=await fetchSafe('proxy-hls-child',child);childOk=media?.ok;
    const denied=await fetchSafe('anonymous-hls-child',child,{credentials:'omit'});anonymousChildDenied=denied?.status===401;
    const mediaText=media?await media.text():'';
    const init=mediaText.match(/URI="([^"]+)"/)?.[1];
    if(init){const r=await fetchSafe('proxy-hls-init',init);initOk=r?.ok;}
    const segment=mediaText.split('\n').find(v=>v.trim()&&!v.startsWith('#'))?.trim();
    if(segment){const r=await fetchSafe('proxy-hls-segment',segment);segmentOk=r?.ok;}
  }
  const native=await fetchSafe('proxy-native-hls',root+'hls/'+encodeURIComponent(f.source)+'/index.m3u8');
  const nativeText=native?await native.text():'';
  const leaked=document.cookie.includes('session=');
  return {observations,directRejected:direct===null,basicOk:!!basicOk,proxyBasicOk:proxyBasic?.ok,loginOk:body.success===true&&!('token'in body)&&!('session'in body),inventoryOk:inv.streams?.some(s=>s.name===f.source)&&typeof inv.total_pages==='number',proxyWs,sdpValid,sdpStatus:answer?.status,childOk,segmentOk,initOk,scoped,anonymousChildDenied,nativeOk:native?.ok&&nativeText.startsWith('#EXTM3U'),httpOnly:!leaked};
 },fixture);
 report.endpoints=result.observations;
 report.preflights=preflights;report.wsHandshakes=handshakes;report.directBasicFetch=result.basicOk?'available':'blocked';
 for(const [name,passed] of Object.entries({directCredentialCorsRejected:result.directRejected,directBasicPreflightRejected:!result.basicOk&&preflights.some(p=>p.status===404),sameOriginBasicFetch:result.proxyBasicOk,cookieLogin:result.loginOk,httpOnly:result.httpOnly,inventory:result.inventoryOk,directWsRejected:!directWsAuthenticated,proxyWsOpened:result.proxyWs,wsHandshakeStatuses:handshakes.some(h=>h.status===403)&&handshakes.some(h=>h.status===101),sdpAnswer:result.sdpValid&&result.sdpStatus===201,hlsScopedChild:result.childOk&&result.scoped,anonymousHlsChildDenied:result.anonymousChildDenied,hlsInit:result.initOk,hlsSegment:result.segmentOk,nativePlaylist:result.nativeOk}))check(name,passed);
 report.endpoints=result.observations;
 const cookies=await context.cookies(proxy.origin+'/lightnvr/front/');
 check('cookieScope',cookies.some(c=>c.name==='session'&&c.httpOnly&&c.path==='/lightnvr/front/'&&c.sameSite==='Lax'));
 check('cookieAbsentFromHa',!(await context.cookies(proxy.origin+'/')).some(c=>c.name==='session'));
 // Hostile origins are checked by the edge independently of upstream checks.
 const hostile=await fetch(proxy.origin+'/lightnvr/front/api/auth/verify',{headers:{Origin:'http://hostile.invalid'}});
 check('hostileOrigin',hostile.status===403,{status:hostile.status});
 await context.close();report.status='passed';
} catch(error){report.status='failed';report.failure=error instanceof Error && error.message.startsWith('Probe assertion')?error.message:'Fixture/browser execution failed; inspect locally without publishing secrets';process.exitCode=1;if(process.env.LIGHTNVR_PROBE_DEBUG)await writeFile(process.env.LIGHTNVR_PROBE_DEBUG,String(error),{mode:0o600});}
finally {await browser?.close();await proxy.close();}
const output=JSON.stringify(report,null,2)+'\n';
if(process.env.LIGHTNVR_PROBE_REPORT)await writeFile(process.env.LIGHTNVR_PROBE_REPORT,output,{mode:0o600});
console.log(output);
