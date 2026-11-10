// Owned generated media + isolated protocol-shaped fixture. This is not an upstream proof.
import { build } from 'vite';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const output = await mkdtemp(join(tmpdir(), 'lightnvr-T5-browser-'));
let browser;
const sockets = new Set();
const cookie = randomBytes(16).toString('hex');
let authenticatedWs = 0, authenticatedHls = 0;
const media = resolve('tests/fixtures/media');
const init = await readFile(join(media, 'init.mp4'));
const avc = init.indexOf('avcC');
assert(avc > 0);
const mime = `video/mp4; codecs="avc1.${init.subarray(avc + 5, avc + 8).toString('hex')},mp4a.40.2"`;
const segments = await Promise.all([0, 1, 2].map(n => readFile(join(media, `segment-${n}.m4s`))));
function frame(opcode, data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : Buffer.alloc(4);
  if (payload.length >= 126) { header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  return Buffer.concat([header, payload]);
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture.invalid');
  if (url.pathname === '/') { response.end('<!doctype html><video muted playsinline></video><script type="module">import * as smoke from "/bundle.js"; window.smoke=smoke;</script>'); return; }
  if (url.pathname === '/bundle.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(join(output, 'bundle.js'))); return; }
  if (request.headers.cookie !== `fixture_session=${cookie}`) { response.writeHead(401).end(); return; }
  authenticatedHls++;
  if (url.pathname.endsWith('/api/stream.m3u8')) {
    response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000,CODECS="avc1.42c00a,mp4a.40.2"\nhls/playlist.m3u8?id=generated%2Bsession\n'); return;
  }
  assert.equal(url.searchParams.get('id'), 'generated+session');
  if (url.pathname.endsWith('/playlist.m3u8')) {
    response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    response.end('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4?id=generated%2Bsession"\n' + segments.map((_, n) => `#EXTINF:1.000000,\nsegment.m4s?id=generated%2Bsession&n=${n}\n`).join('') + '#EXT-X-ENDLIST\n'); return;
  }
  response.setHeader('Content-Type', 'video/mp4');
  if (url.pathname.endsWith('/init.mp4')) response.end(init);
  else if (url.pathname.endsWith('/segment.m4s')) response.end(segments[Number(url.searchParams.get('n'))]);
  else response.writeHead(404).end();
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
server.on('upgrade', (request, socket) => {
  assert.equal(request.headers.cookie, `fixture_session=${cookie}`);
  assert.equal(new URL(request.url, 'http://fixture.invalid').pathname, '/nvr/front/go2rtc/api/ws');
  authenticatedWs++;
  const key = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
  let negotiated = false;
  socket.on('data', data => {
    if ((data[0] & 0x0f) === 8) { socket.end(frame(8, Buffer.alloc(0))); return; }
    if (negotiated) return;
    negotiated = true;
    socket.write(frame(1, JSON.stringify({ type: 'mse', value: mime })));
    socket.write(frame(2, init));
    for (const segment of segments) socket.write(frame(2, segment));
  });
  socket.on('error', () => {});
});
try {
  await build({ configFile: false, logLevel: 'error', build: { outDir: output, emptyOutDir: false, sourcemap: false,
    lib: { entry: resolve('tests/unit/hls/browser-entry.ts'), formats: ['es'], fileName: () => 'bundle.js' }, rollupOptions: { output: { inlineDynamicImports: true } } } });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.LIGHTNVR_CHROMIUM ?? '/usr/bin/chromium-browser', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext();
  await context.addCookies([{ name: 'fixture_session', value: cookie, url: origin + '/nvr/front/' }]);
  const page = await context.newPage();
  await page.goto(origin); await page.waitForFunction(() => Boolean(window.smoke));
  const results = [];
  for (const kind of ['mse', 'hls']) {
    await page.evaluate(kind => window.smoke.start(kind), kind);
    await page.waitForFunction(() => window.smoke.snapshot().events.some(event => event.type === 'first-frame'), { timeout: 15000 });
    await page.evaluate(() => window.smoke.listen());
    await page.waitForFunction(() => window.smoke.snapshot().audioDecodedBytes > 0);
    const playing = await page.evaluate(() => window.smoke.snapshot());
    assert(playing.width > 0); assert.equal(playing.muted, false); assert(!playing.events.some(e => e.type === 'failure'));
    await page.evaluate(() => window.smoke.stop());
    const stopped = await page.evaluate(() => window.smoke.snapshot());
    assert.equal(stopped.src, null); assert.equal(stopped.hasSourceObject, false); assert.equal(stopped.urlCreates, stopped.urlRevokes);
    results.push({ kind, decodedVideo: true, decodedAudio: true, localSpeakerUnmuted: true, detached: true, mseObjectUrlsRevoked: true });
  }
  assert.equal(authenticatedWs, 1); assert(authenticatedHls >= 4);
  console.log(JSON.stringify({ status: 'passed', browser: browser.version(), fixture: 'generated H.264/AAC; isolated synthetic WS/HLS; no upstream compatibility claim', results }));
} finally {
  await browser?.close();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolveClose => server.close(resolveClose));
  await rm(output, { recursive: true, force: true });
}
