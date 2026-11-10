import https from 'node:https';
import http from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {X509Certificate,createHash} from 'node:crypto';
import {createRouter} from '../../examples/proxy/router.mjs';

export function assertOwnedFixture(f, label) {

  const info=JSON.parse(execFileSync('podman',[...(f.podman_args??[]),'inspect',f.container],{encoding:'utf8'}))[0];
  if(info.Config.Labels?.['io.lightnvr-card.fixture'] !== label)throw Error('Only owned test fixtures accepted');
  const u=new URL(f.origin);
  if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.pathname!=='/'||u.username||u.password||u.search||u.hash)throw Error('Only generated loopback origin accepted');
  const ports=Object.values(info.NetworkSettings.Ports).flat();
  if(!ports.some(p=>p?.HostIp==='127.0.0.1'&&p.HostPort===u.port))throw Error('Fixture port differs from owned container');
 return info;
}

export async function startHaEdge(ha,nvr) {
 const info = assertOwnedFixture(ha, 'T10-HA');
 assertOwnedFixture(nvr, 'T1');
 if (!info.Mounts.some(m => m.Destination === '/config' && m.Source === ha.config_dir)) throw Error('HA config mount differs from fixture descriptor');
 const dir=await mkdtemp(join(tmpdir(),'lightnvr-ha-edge-'));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',join(dir,'key'),'-out',join(dir,'cert')],{stdio:'ignore'});
 const cert=await readFile(join(dir,'cert')),key=await readFile(join(dir,'key'));
 let origin,helper;
 const requests=[],sockets=new Set();
 const headers=req=>({...req.headers,host:new URL(origin).host,'x-forwarded-host':new URL(origin).host,'x-forwarded-proto':'https','x-forwarded-for':'127.0.0.1'});
 const target=req=>new URL(req.url.startsWith('/lightnvr/')?helper:ha.origin);
 const edge=https.createServer({key,cert},(req,res)=>{
  if(req.headers.host!==new URL(origin).host){res.writeHead(403).end();return;}
  const u=target(req);
  const upstream=http.request({hostname:u.hostname,port:u.port,path:req.url,method:req.method,headers:headers(req)},response=>{
   requests.push({path:req.url.split('?')[0],status:response.statusCode,method:req.method});
   res.writeHead(response.statusCode,response.headers);response.pipe(res);
  });
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);
 });
 edge.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 edge.on('upgrade',(req,socket,head)=>{
  if(req.headers.host!==new URL(origin).host||req.headers.origin!==origin){socket.destroy();return;}
  const u=target(req);
  const upstream=http.request({hostname:u.hostname,port:u.port,path:req.url,method:req.method,headers:headers(req)});
  upstream.on('upgrade',(response,remote,remoteHead)=>{
   requests.push({path:req.url.split('?')[0],status:101,method:'UPGRADE'});
   socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(response.headers).map(([name,value])=>`${name}: ${value}\r\n`).join('')+'\r\n');
   if(remoteHead.length)socket.write(remoteHead);if(head.length)remote.write(head);
   socket.pipe(remote);remote.pipe(socket);socket.on('close',()=>remote.destroy());remote.on('error',()=>socket.destroy());
  });
  upstream.on('response',response=>{socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`);response.resume();});
  upstream.on('error',()=>socket.destroy());upstream.end();
 });
 await new Promise(resolve=>edge.listen(0,'127.0.0.1',resolve));origin='https://127.0.0.1:'+edge.address().port;
 const router=createRouter({bind:'127.0.0.1',origins:[origin],trustedPeers:['127.0.0.1'],scopes:[
  {prefix:'/lightnvr/front/',cookieName:'lnvr_ha_front',upstream:nvr.origin},
  {prefix:'/lightnvr/denied/',cookieName:'lnvr_ha_denied',upstream:nvr.origin},
 ]});
 await new Promise(resolve=>router.server.listen(0,'127.0.0.1',resolve));helper='http://127.0.0.1:'+router.server.address().port;
 return {origin,requests,spki:createHash('sha256').update(new X509Certificate(cert).publicKey.export({type:'spki',format:'der'})).digest('base64'),
  async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>edge.close(resolve));await router.close();await rm(dir,{recursive:true,force:true});},
 };
}
