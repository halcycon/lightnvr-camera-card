// Proof helper, not a deployment proxy. Upstream is always isolated loopback lightNVR.
import http from 'node:http';
import { pipeline } from 'node:stream';
function safeTargetPath(path) {
  const pathname = path.split('?')[0];
  try {
    const decoded = decodeURIComponent(pathname);
    return pathname.startsWith('/') && !pathname.startsWith('//') && !/%2f/i.test(pathname) &&
      !decoded.includes('\\') && !decoded.includes('%') && !decoded.includes('//') &&
      !decoded.split('/').some(part => part === '.' || part === '..') &&
      ![...decoded].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127);
  } catch { return false; }
}
export async function startProxy(upstream) {
  const target = new URL(upstream);
  if (target.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(target.hostname) ||
      target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw Error('Only generated loopback HTTP fixture roots are allowed');
  }
  const scopes = ['/lightnvr/front/', '/lightnvr/back/'];
  const server = http.createServer((req, res) => {
    const prefix = scopes.find(p => req.url.startsWith(p));
    if (!prefix) { res.writeHead(200, {'Content-Type':'text/html'}); res.end('<!doctype html><title>Isolated HA origin fixture</title>'); return; }
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403); res.end(); return; }
    const path = '/' + req.url.slice(prefix.length);
    if (!safeTargetPath(path)) { res.writeHead(400, {Connection:'close'}); res.end(); return; }
    const headers = { ...req.headers, 'accept-encoding':'identity' };
    // Only the chosen NVR session; no HA cookies or shared administrator credentials.
    headers.cookie = (req.headers.cookie ?? '').split(';').map(v=>v.trim()).filter(v=>v.startsWith('session=')).join('; ');
    const upstreamReq = http.request({ protocol:target.protocol, hostname:target.hostname.replace(/^\[|\]$/g,''), port:target.port, path, method:req.method, headers }, response => {
      const h = {...response.headers};
      if (h['set-cookie']) h['set-cookie'] = h['set-cookie'].map(c=>c.replace(/;\s*Domain=[^;]+/ig,'').replace(/;\s*Path=[^;]+/i,`; Path=${prefix}`));
      if (h.location?.startsWith('/')) h.location = prefix + h.location.slice(1);
      const playlist = /mpegurl/i.test(String(h['content-type']));
      if (!playlist) { res.writeHead(response.statusCode, h); pipeline(response,res,()=>{}); return; }
      const chunks=[]; let size=0;
      response.on('data', b => { size+=b.length; if(size>1024*1024) response.destroy(); else chunks.push(b); });
      response.on('end', () => {
        // Preserve all query strings/session IDs. Resolve every URI including EXT-X-MAP/KEY.
        const rewrite = value => {
          const u=new URL(value,new URL(path,target));
          if (u.origin!==target.origin) throw new Error('Foreign playlist origin');
          if (!u.pathname.startsWith('/go2rtc/') && !u.pathname.startsWith('/hls/')) throw new Error('Foreign playlist path');
          return prefix + u.pathname.slice(1) + u.search;
        };
        try {
          const body=Buffer.concat(chunks).toString().split('\n').map(line => line.startsWith('#') ? line.replace(/URI="([^"]+)"/g,(_,uri)=>`URI="${rewrite(uri)}"`) : line.trim() ? rewrite(line.trim()) : line).join('\n');
          delete h['content-length']; res.writeHead(response.statusCode,h); res.end(body);
        } catch { res.writeHead(502); res.end(); }
      });
    });
    upstreamReq.on('error',()=>{res.writeHead(502);res.end();});
    pipeline(req,upstreamReq,()=>{});
  });
  server.on('upgrade',(req,socket,head)=>{
    const prefix=scopes.find(p=>req.url.startsWith(p));
    if (!prefix || req.headers.origin !== `http://${req.headers.host}`) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const headers={...req.headers,cookie:(req.headers.cookie??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith('session=')).join('; ')};
    const path='/'+req.url.slice(prefix.length);
    if (!safeTargetPath(path)) { socket.end('HTTP/1.1 400 Rejected\r\nConnection: close\r\n\r\n'); return; }
    const remote=http.request({protocol:target.protocol,hostname:target.hostname.replace(/^\[|\]$/g,''),port:target.port,path,headers});
    remote.on('upgrade',(response,peer,remoteHead)=>{
      socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(response.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\n\r\n');
      if(remoteHead.length)socket.write(remoteHead);if(head.length)peer.write(head);
      socket.pipe(peer).pipe(socket); socket.on('error',()=>peer.destroy());peer.on('error',()=>socket.destroy());
    });
    remote.on('response',response=>{socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`);response.resume();});
    remote.on('error',()=>socket.destroy());remote.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {origin:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
