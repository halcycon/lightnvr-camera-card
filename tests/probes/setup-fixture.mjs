// Starts only a new isolated ephemeral fixture. No production hosts or mounted DBs.
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
const image='ghcr.io/opensensor/lightnvr@sha256:16303e3b8116fa8fbc565d0548b54bb81a4062f9d9a3fc8961e895b5d8191c11';
const dir=await mkdtemp(`${tmpdir()}/lightnvr-T1-`);
const name=`lightnvr-t1-${randomBytes(4).toString('hex')}`,network=name+'-net';
// Upstream INI bootstrap web_password buffer holds at most 31 bytes.
const password=randomBytes(12).toString('hex');
let phase='container startup';
const podman=(...args)=>execFileSync('podman',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000}).trim();
const config=`[general]
pid_file = /var/run/lightnvr/lightnvr.pid
log_file = /tmp/lightnvr-t1.log
log_level = 1
[storage]
path = /var/lib/lightnvr/data/recordings
[database]
path = /var/lib/lightnvr/data/database/lightnvr.db
[models]
path = /var/lib/lightnvr/data/models
[web]
port = 8080
root = /var/lib/lightnvr/www
auth_enabled = true
password = ${password}
[go2rtc]
binary_path = /bin/go2rtc
config_dir = /etc/lightnvr/go2rtc
webrtc_enabled = true
stun_enabled = false
`;
await writeFile(dir+'/lightnvr.ini',config);
podman('network','create','--internal',network);
try {
 podman('run','-d','--name',name,'--label','io.lightnvr-card.fixture=T1','--network',network,'-p','127.0.0.1::8080','-v',`${dir}/lightnvr.ini:/etc/lightnvr/lightnvr.ini:ro,Z`,'-e','LIGHTNVR_AUTO_INIT=true',image);
 const port=podman('port',name,'8080/tcp').split(':').at(-1);
 const origin=`http://127.0.0.1:${port}/`;
 const authorization='Basic '+Buffer.from('admin:'+password).toString('base64');
 phase='readiness';
 let ready=false;
 for(let i=0;i<60;i++){
  if(i%5===0 && podman('inspect',name,'--format','{{.State.Running}}')!=='true')break;
  try{const r=await fetch(origin+'api/auth/verify',{headers:{authorization},signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break;}}catch{/* startup */}
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 if(!ready)throw new Error('Fixture did not start');
 phase='generated source registration';
 for (const source of ['generated', 'generated_lobby']) {
 const r=await fetch(origin+'api/streams',{method:'POST',headers:{authorization,'Content-Type':'application/json'},body:JSON.stringify({name:source,url:'rtsp://127.0.0.1:8554/'+source,go2rtc_source_override:'ffmpeg:virtual?video=testsrc#video=h264',record:false,enabled:true,streaming_enabled:true,backchannel_enabled:false}),signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw new Error('Generated source setup failed');
 }
 await writeFile(dir+'/fixture.json',JSON.stringify({origin,username:'admin',password,source:'generated',second_source:'generated_lobby',container:name}),{mode:0o600});
 console.log(`Fixture ready. Descriptor (private): ${dir}/fixture.json`);
 console.log(`Run: LIGHTNVR_PROBE_FIXTURE=${dir}/fixture.json npm run test:probe`);
 console.log(`Cleanup: podman rm -f ${name} && podman network rm ${network}`);
} catch {
 try{await writeFile(dir+'/failure.log',podman('logs',name),{mode:0o600});}catch{/* absent */}
 try{podman('rm','-f',name);}catch{/* absent */}
 try{podman('network','rm',network);}catch{/* absent */}
 throw new Error(`Isolated fixture failed during ${phase}; private logs: ${dir}/failure.log. No compatibility claim established.`);
}
