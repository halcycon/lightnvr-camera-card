import { describe, it, expect } from 'vitest';
import { cardConfigSchema, validateConfig, stripHaMetadata, migrateLegacy, loginResponseSchema, streamPageSchema } from '../../src/contracts';
import example from '../fixtures/contracts/config.json';
import legacy from '../fixtures/contracts/legacy.json';
const base={type:'custom:lightnvr-camera-card',server:'/lightnvr/front/',stream:'generated'};
describe('frozen configuration',()=>{
 it('preserves native HA metadata separately from playback visibility',()=>{
  const metadata={grid_options:{columns:24,rows:'auto',min_rows:0},view_layout:{grid_area:'front',custom_layout:{column:2}},layout_options:{grid_columns:'full'},visibility:[{condition:'screen',media_query:'(min-width: 600px)'}],index:0,view_index:1,disabled:false};
  const config=validateConfig({...base,...metadata,playback_visibility:{hidden:'continue'}});
  expect(config).toMatchObject(metadata);
  expect(config.playback_visibility).toEqual({hidden:'continue',offscreen:'pause'});
  expect(stripHaMetadata(config)).toEqual(validateConfig({...base,playback_visibility:{hidden:'continue'}}));
  expect(validateConfig(JSON.parse(JSON.stringify(config)))).toEqual(config);
 });
 it('normalizes the pre-release visibility-policy object without consuming HA conditions',()=>{
  const config=validateConfig({...base,visibility:{offscreen:'continue'}});
  expect(config.visibility).toBeUndefined();expect(config.playback_visibility.offscreen).toBe('continue');
  expect(cardConfigSchema.safeParse({...base,visibility:{hidden:'pause'},playback_visibility:{hidden:'continue'}}).success).toBe(false);
 });
 it('keeps native HA layout and condition metadata when migrating an existing card',()=>{
  const metadata={grid_options:{columns:24,rows:'auto'},view_layout:{grid_area:'front'},visibility:[{condition:'screen',media_query:'(min-width: 600px)'}]};
  const migrated=migrateLegacy({server:'https://viewer:owned-password@example.test/go2rtc/',url:'front_door_sub',...metadata});
  expect(migrated.config).toMatchObject(metadata);expect(migrated.config.source).toBe('front_door_sub');
  expect(migrated.config.server).toBe('https://example.test/');expect(migrated.config.playback_visibility.hidden).toBe('pause');
 });
 it('validates all plan examples, defaults and JSON round trips',()=>{
  for(const input of [base,example,{...example,server:'https://nvr.example.test/'},{...base,stream:'driveway',profile:'sub'}]){
   const config=validateConfig(input); expect(validateConfig(JSON.parse(JSON.stringify(config)))).toEqual(config);
   expect(config.timeouts.connection_ms).toBe(30000);expect(config.retry.cap_ms).toBe(30000);
  }
 });
 it('round trips every advanced setting',()=>{
  const c=validateConfig({...base,viewer_url:'https://nvr.example.test/',go2rtc_path:'nested/go2rtc/',source:'exact_sub',video:{enabled:true},audio:{listen:false,microphone:true},visibility:{hidden:'continue',offscreen:'pause'},layout:{object_fit:'cover',aspect_ratio:4/3,fullscreen_main:true},ice_servers:[{urls:['turn:relay.example.test:3478'],username:'EXAMPLE',credential:'EXAMPLE'}],timeouts:{webrtc_ms:12000,mse_ms:13000,hls_ms:14000},controls:{refresh_source:false}});
  expect(validateConfig(JSON.parse(JSON.stringify(c)))).toEqual(c);
 });
 it.each([
  {server:'https://u:p@nvr.example.test/'},{server:'//nvr.example.test/'},{server:'javascript:alert(1)'},{server:'https://nvr.example.test/?secret=x'},
  {transports:[]},{transports:['webrtc','webrtc']},{transports:['imaginary']},{retry:{base_ms:30000,cap_ms:2000}},
  {audio:{enabled:false}},{audio:{microphone:true},transports:['hls']},{video:{enabled:false}},{go2rtc_path:'../go2rtc/'},
  {audio:{typo:true}},{advanced_unknown:true},{ice_servers:[{urls:'https://relay.example.test'}]},
 ])('rejects unsafe or ambiguous config %j',patch=>{expect(cardConfigSchema.safeParse({...base,...patch}).success).toBe(false);});
 it('accepts explicit complete audio disable and session-only credentials',()=>{
  expect(validateConfig({...base,credential_storage:'session',audio:{enabled:false,listen:false,microphone:false}}).audio.enabled).toBe(false);
 });
});
describe('explicit legacy migration preview',()=>{
 it('preserves exact source and microphone intent from actual requested input',()=>{
  const {config}=migrateLegacy(legacy);
  expect(config.server).toBe('https://nvr.example.test/');expect(config.username).toBe('USER');expect(config.password).toBe('P@SS');
  expect(config.source).toBe('front_door_sub');expect(config.stream).toBe('front_door_sub');expect(config.profile).toBe('main');
  expect(config.audio).toMatchObject({listen:true,microphone:true,muted:false});expect(config.transports).toEqual(['webrtc']);
  expect(validateConfig(JSON.parse(JSON.stringify(config)))).toEqual(config);
 });
 it('decodes reserved and non-ASCII credentials exactly once',()=>{
  const {config}=migrateLegacy({...legacy,server:'https://u%3A%E2%98%83:p%252F%40@nvr.example.test/nested/go2rtc/'});
  expect(config.username).toBe('u:☃');expect(config.password).toBe('p%2F@');expect(config.server).toBe('https://nvr.example.test/nested/');
 });
 it('keeps object media compatibility and rejects unknown options without losing them',()=>{
  expect(migrateLegacy({...legacy,media:{video:true,audio:false,microphone:true},ui:false}).config.audio.listen).toBe(false);
  expect(()=>migrateLegacy({...legacy,unknown:true})).toThrow();expect(()=>migrateLegacy({...legacy,media:'video,imaginary'})).toThrow();
 });
});
describe('wire schemas are not fictional bearer authentication',()=>{
 it('accepts normal cookie login and separate ephemeral TOTP challenge',()=>{
  expect(loginResponseSchema.parse({success:true,redirect:'/index.html',must_change_password:false})).not.toHaveProperty('token');
  expect(loginResponseSchema.parse({totp_required:true,totp_token:'EPHEMERAL_EXAMPLE'})).toHaveProperty('totp_required',true);
  expect(loginResponseSchema.safeParse({token:'fake'}).success).toBe(false);
 });
 it('selects credential-free inventory fields and validates pagination',()=>{
  const page=streamPageSchema.parse({streams:[{name:'generated',url:'rtsp://EXAMPLE_ONLY',password:'EXAMPLE_ONLY',has_sub_stream:true}],page:1,page_size:100,total:101,total_pages:2});
  expect(page.total_pages).toBe(2);expect(page.streams[0]).not.toHaveProperty('url');expect(page.streams[0]).not.toHaveProperty('password');
  expect(streamPageSchema.safeParse({...page,total_pages:-1}).success).toBe(false);
 });
});
