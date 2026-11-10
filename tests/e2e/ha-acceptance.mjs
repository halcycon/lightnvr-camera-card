import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {parse} from 'yaml';
import {chromium} from '@playwright/test';
import {connectHa} from './ha-api.mjs';
import {startHaEdge} from './ha-edge.mjs';
import {confirmFixtureProxy} from './ha-http-config.mjs';

const haPath=process.env.LIGHTNVR_HA_FIXTURE;
if (!haPath || !process.env.LIGHTNVR_PROBE_FIXTURE || !process.env.LIGHTNVR_BUILD_DIR || !process.env.LIGHTNVR_E2E_OUTPUT) throw Error('Explicit isolated fixture, build and private output paths are required');
const output = process.env.LIGHTNVR_E2E_OUTPUT;
await mkdir(output, {recursive:true,mode:0o700});
const ha=JSON.parse(await readFile(haPath,'utf8'));
const nvr=JSON.parse(await readFile(process.env.LIGHTNVR_PROBE_FIXTURE,'utf8'));
const extra=nvr.second_source;
if (!extra || extra === nvr.source) throw Error('Two distinct generated fixture sources are required');
const preview={bundle:join(process.env.LIGHTNVR_BUILD_DIR,'lightnvr-camera-card.js')};
await confirmFixtureProxy(haPath);
const edge=await startHaEdge(ha,nvr),results=[];
const receiptPath=join(output,'card-acceptance-receipt.json');
let browser,api,page;
let phase='setup';
const base=(source=nvr.source,kind='mse',title='Generated front door')=>({
 type:'custom:lightnvr-camera-card',server:'/lightnvr/front/',username:nvr.username,password:nvr.password,
 stream:source,title,transports:[kind],playback_visibility:{hidden:'pause',offscreen:'pause'},
 controls:{microphone:true},
});
const panel=(path,card)=>({title:path,path,type:'panel',cards:[card]});
const sectionCard={...base(),grid_options:{columns:6,rows:'auto'},visibility:[{condition:'screen',media_query:'(min-width: 1px)'}]};
const config={title:'lightNVR acceptance',views:[
 panel('mse',base()),panel('hls',base(nvr.source,'hls')),
 panel('fallback',{...base(),transports:['webrtc','mse','hls']}),
 {title:'Grid',path:'grid',cards:[{type:'grid',columns:2,square:false,cards:[base(),base(extra,'mse','Generated lobby')]}]},
 {title:'Sections',path:'sections',type:'sections',max_columns:2,sections:[{type:'grid',cards:[sectionCard]}]},
 panel('denied',{...base(),server:'/lightnvr/denied/',transports:['webrtc','mse','hls']}),
]};
async function checkpoint(){await writeFile(receiptPath,JSON.stringify({status:'in-progress',ha:ha.version,results},null,2));}
async function record(name,extra={}){results.push({name,status:'passed',...extra});await checkpoint();console.log('PASS',name);}
async function frames(card){
 const handle=await card.elementHandle();
 await page.waitForFunction(e=>{const v=e.shadowRoot?.querySelector('video');return v?.videoWidth>0&&!v.paused&&v.getVideoPlaybackQuality().totalVideoFrames>0;},handle,{timeout:35000});
 return card.evaluate(e=>{const v=e.shadowRoot.querySelector('video');return {width:v.videoWidth,frames:v.getVideoPlaybackQuality().totalVideoFrames,status:e.shadowRoot.querySelector('.status')?.textContent??'',muted:v.muted,volume:v.volume,src:v.getAttribute('src')};});
}
try {
 const destination=join(ha.config_dir,'www/community/lightnvr-camera-card');await mkdir(destination,{recursive:true});await copyFile(preview.bundle,join(destination,'lightnvr-camera-card.js'));
 const bundleSha256=createHash('sha256').update(await readFile(preview.bundle)).digest('hex');
 const hash=bundleSha256.slice(0,12);
 api=await connectHa(haPath);
 const resources=await api.call('lovelace/resources'),url='/local/community/lightnvr-camera-card/lightnvr-camera-card.js?v='+hash;
 const existing=resources.find(r=>r.url.includes('/community/lightnvr-camera-card/'));
 await api.call(existing?'lovelace/resources/update':'lovelace/resources/create',{...(existing?{resource_id:existing.id}:{}),res_type:'module',url});
 const dashboards=await api.call('lovelace/dashboards/list');
 if(!dashboards.some(d=>d.url_path==='lightnvr-check'))await api.call('lovelace/dashboards/create',{url_path:'lightnvr-check',title:'lightNVR acceptance',icon:'mdi:cctv',show_in_sidebar:true,require_admin:true});
 await api.call('lovelace/config/save',{url_path:'lightnvr-check',config});
 browser=await chromium.launch({...(process.env.LIGHTNVR_CHROMIUM ? {executablePath:process.env.LIGHTNVR_CHROMIUM} : {}),headless:true,args:['--ignore-certificate-errors-spki-list='+edge.spki]});
 const context=await browser.newContext({viewport:{width:1440,height:1100}});
 let microphoneRequests=0;await context.exposeBinding('__lightnvrCaptureAttempt',()=>{microphoneRequests++;});
 await context.addInitScript(()=>{window.__micRequests=0;const media=navigator.mediaDevices;if(media?.getUserMedia){const original=media.getUserMedia.bind(media);media.getUserMedia=(...args)=>{window.__micRequests++;void window.__lightnvrCaptureAttempt();return original(...args);};}});
 page=await context.newPage();let injected502=0,injected403=0;
 await page.route('**/lightnvr/front/go2rtc/api/webrtc?*',route=>{injected502++;return route.fulfill({status:502,contentType:'text/plain',body:'Owned acceptance fault'});});
 await page.route('**/lightnvr/denied/go2rtc/api/webrtc?*',route=>{injected403++;return route.fulfill({status:403,contentType:'text/plain',body:'Owned acceptance denial'});});
 await page.goto(edge.origin+'/lightnvr-check/mse');
 await page.getByRole('textbox',{name:'Username',exact:true}).fill(ha.credentials.username);
 await page.getByLabel('Password',{exact:true}).fill(ha.credentials.password);await page.getByRole('button',{name:/log in/i}).click();
 let card=page.locator('lightnvr-camera-card:visible').first();await card.waitFor({timeout:30000});let state=await frames(card);assert.match(state.status,/playing.*MSE/i);assert.equal(await page.evaluate(()=>document.querySelector('home-assistant')?.hass?.config.version),ha.version);
 await record('panel MSE real frames',{width:state.width});
 phase='unmute';console.log('STEP',phase);await card.getByRole('button',{name:'Listen',exact:true}).click();assert.equal((await frames(card)).muted,false);
 phase='volume';console.log('STEP',phase);const slider=card.getByRole('slider',{name:'Speaker volume'});await slider.evaluate(e=>{e.value='0.4';e.dispatchEvent(new Event('input',{bubbles:true}));});
 phase='metadata';console.log('STEP',phase);const before=await frames(card),authBefore=edge.requests.filter(r=>/\/api\/auth\//.test(r.path)).length;
 await card.evaluate((e,c)=>e.setConfig({...c,grid_options:{columns:24,rows:'auto'},view_layout:{grid_area:'front'},visibility:[{condition:'screen',media_query:'(min-width: 1px)'}]}),base());
 await page.waitForTimeout(600);state=await frames(card);assert.equal(state.src,before.src);assert.equal(state.volume,0.4);assert.equal(state.muted,false);assert.equal(edge.requests.filter(r=>/\/api\/auth\//.test(r.path)).length,authBefore);await record('native HA metadata preserves player auth speaker and volume');
 phase='retry';console.log('STEP',phase);await card.getByRole('button',{name:'Play / retry locally',exact:true}).click();state=await frames(card);assert.equal(state.volume,0.4);assert.equal(state.muted,false);await record('explicit retry preserves local speaker and volume');
 phase='snapshot';console.log('STEP',phase);const downloadPromise=page.waitForEvent('download');
 await card.getByRole('button',{name:'Snapshot',exact:true}).click();
 console.log('STEP snapshot clicked');const download=await downloadPromise;assert.match(download.suggestedFilename(),/\.jpg$/);
 const downloadPath=await download.path();const jpeg=await readFile(downloadPath);assert.equal(jpeg.subarray(0,2).toString('hex'),'ffd8');
 await record('authorized real JPEG snapshot download');
 await page.screenshot({path:join(output,'card-panel.png')});
 phase='hls';await page.goto(edge.origin+'/lightnvr-check/hls');card=page.locator('lightnvr-camera-card:visible').first();await card.waitFor();state=await frames(card);assert.match(state.status,/playing.*HLS/i);await record('panel HLS real frames',{width:state.width});
 phase='fallback';await page.goto(edge.origin+'/lightnvr-check/fallback');card=page.locator('lightnvr-camera-card:visible').first();await card.waitFor();state=await frames(card);assert(injected502>0);assert.match(state.status,/playing.*MSE/i);await record('injected WebRTC proxy502 falls back to real MSE');
 phase='grid';await page.goto(edge.origin+'/lightnvr-check/grid');let cards=page.locator('lightnvr-camera-card:visible');await cards.nth(1).waitFor();await frames(cards.nth(0));await frames(cards.nth(1));await page.screenshot({path:join(output,'card-grid.png')});
 const first=await cards.nth(0).elementHandle(),other=await cards.nth(1).elementHandle();const otherBefore=await other.evaluate(e=>e.shadowRoot.querySelector('video').currentTime);await first.evaluate(e=>e.remove());await page.waitForTimeout(1000);
 assert(await other.evaluate((e,t)=>{const v=e.shadowRoot.querySelector('video');return !v.paused&&v.currentTime>t;},otherBefore));assert(await first.evaluate(e=>{const v=e.shadowRoot.querySelector('video');return !v.srcObject&&!v.getAttribute('src');}));await record('two-camera native grid and independent removal');
 phase='sections';await page.goto(edge.origin+'/lightnvr-check/sections');card=page.locator('lightnvr-camera-card:visible').first();await card.waitFor();await frames(card);await page.reload();card=page.locator('lightnvr-camera-card:visible').first();await card.waitFor();await frames(card);await record('Sections native grid metadata and reload');
 sectionCard.visibility=[{condition:'screen',media_query:'(max-width: 1px)'}];await api.call('lovelace/config/save',{url_path:'lightnvr-check',config});await page.reload();await page.locator('hui-sections-view').waitFor();await page.waitForTimeout(1200);assert.equal(await page.locator('lightnvr-camera-card:visible').count(),0);assert.equal(await page.locator('hui-error-card').count(),0);
 sectionCard.visibility=[{condition:'screen',media_query:'(min-width: 1px)'}];await api.call('lovelace/config/save',{url_path:'lightnvr-check',config});await page.reload();card=page.locator('lightnvr-camera-card:visible').first();await card.waitFor();await frames(card);await record('native HA visibility condition hides and restores card');
 phase='editor';await page.evaluate(async c=>{const C=customElements.get('lightnvr-camera-card');const editor=await C.getConfigElement();editor.id='acceptance-editor';editor.setConfig(c);editor.style.cssText='position:fixed;inset:16px;z-index:9999;background:white;color:#222;overflow:auto;padding:16px;max-width:920px;margin:auto';window.__editorSaved=false;editor.addEventListener('config-changed',event=>{const saved=event.detail.config;window.__editorSaved=saved.grid_options?.columns===6&&Array.isArray(saved.visibility)&&saved.playback_visibility?.hidden==='pause';});document.body.append(editor);await editor.updateComplete;},sectionCard);
 const editor=page.locator('#acceptance-editor');await editor.getByRole('button',{name:'2. Test connection',exact:true}).click();await editor.getByRole('button',{name:'3. Discover cameras',exact:true}).click();await editor.getByRole('checkbox',{name:`Include ${nvr.source} in YAML`,exact:true}).waitFor();await editor.getByRole('checkbox',{name:`Include ${extra} in YAML`,exact:true}).check();await editor.getByRole('checkbox',{name:`Include ${nvr.source} in YAML`,exact:true}).check();
 await editor.locator('.camera').filter({has:page.getByRole('checkbox',{name:`Include ${nvr.source} in YAML`,exact:true})}).getByRole('button',{name:'Preview main snapshot',exact:true}).click();
 await editor.getByRole('img',{name:nvr.source+' — main snapshot',exact:true}).waitFor();
 await page.waitForFunction(img=>img.complete&&img.naturalWidth>0,await editor.getByRole('img').elementHandle());
 await editor.getByRole('button',{name:'Close preview',exact:true}).click();
 await record('real editor authorized JPEG snapshot preview');
 await editor.locator('.camera').filter({has:page.getByRole('checkbox',{name:`Include ${nvr.source} in YAML`,exact:true})}).getByRole('button',{name:'Use for this card',exact:true}).click();assert(await page.evaluate(()=>window.__editorSaved));await editor.getByRole('button',{name:'Generate native grid',exact:true}).click();const yaml=await editor.getByRole('textbox',{name:'Generated YAML',exact:true}).inputValue();assert(!yaml.includes(nvr.password),'Credential appeared in exported YAML');assert.equal(parse(yaml).cards.length,2);await editor.screenshot({path:join(output,'editor.png')});await editor.evaluate(e=>e.remove());await frames(card);await record('real editor discover select metadata and two-camera grid YAML');
 phase='denied';await page.goto(edge.origin+'/lightnvr-check/denied');card=page.locator('lightnvr-camera-card:visible').first();await card.waitFor();await page.waitForFunction(e=>/^denied\b/.test(e.shadowRoot.querySelector('.status')?.textContent??''),await card.elementHandle(),{timeout:20000});assert(injected403>0);assert.equal(edge.requests.filter(r=>r.path.startsWith('/lightnvr/denied/go2rtc/')).length,0);await record('injected policy403 has no fallback media requests');
 assert.equal(microphoneRequests,0);await record('no microphone capture on mount render discovery or fallback');
 await writeFile(receiptPath,JSON.stringify({status:'passed',ha:ha.version,browser:browser.version(),bundleSha256,completedAt:new Date().toISOString(),results,scope:'actual owned HA/card/NVR through NodeTLS routing helper; deliberate502/403 fault cases identified; no GitHub-catalog or physical-audio claim'},null,2));console.log('PASS complete actual HA acceptance',ha.version);
}catch(error){await writeFile(receiptPath,JSON.stringify({status:'failed',ha:ha.version,results,error:error.name,phase,requests:edge.requests},null,2));throw new Error('Owned HA acceptance failed; inspect the sanitized receipt and reproduce locally. Error type: '+error.name);}
finally{api?.close();await browser?.close();console.log('CLEANUP browser closed');await edge.close();console.log('CLEANUP routing closed');}
