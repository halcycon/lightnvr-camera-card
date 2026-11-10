import { assertOwnedFixture } from './ha-edge.mjs';
import { readFile, writeFile } from 'node:fs/promises';

export async function connectHa(path) {
  const fixture = JSON.parse(await readFile(path, 'utf8'));
  assertOwnedFixture(fixture, 'T10-HA');
  if (Date.now() / 1000 - fixture.tokens.received_at > fixture.tokens.expires_in - 60) {
    const response = await fetch(fixture.origin + '/auth/token', { method: 'POST', body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: fixture.tokens.refresh_token, client_id: fixture.tokens.client_id,
    }) });
    if (!response.ok) throw Error('Fixture token refresh failed');
    fixture.tokens = { ...fixture.tokens, ...await response.json(), received_at: Date.now() / 1000 };
    await writeFile(path, JSON.stringify(fixture, null, 2));
  }
  const socket = new WebSocket(fixture.origin.replace(/^http/, 'ws') + '/api/websocket');
  const pending = new Map();
  socket.onclose = () => {
    for (const handler of pending.values()) { clearTimeout(handler.timer); handler.reject(Error('Fixture connection closed')); }
    pending.clear();
  };
  const closeSocket = () => { try { socket.close(); } catch { /* already closing */ } };
  let sequence = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { closeSocket(); reject(Error('Fixture WebSocket auth timeout')); }, 15000);
    socket.onerror = () => { clearTimeout(timer); closeSocket(); reject(Error('Fixture WebSocket unavailable')); };
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.type === 'auth_required') socket.send(JSON.stringify({ type: 'auth', access_token: fixture.tokens.access_token }));
      if (message.type === 'auth_invalid') { clearTimeout(timer); closeSocket(); reject(Error('Fixture WebSocket auth rejected')); }
      if (message.type === 'auth_ok') { clearTimeout(timer); resolve(); }
      if (message.id && pending.has(message.id)) {
        const handler = pending.get(message.id); pending.delete(message.id); clearTimeout(handler.timer);
        if (message.success) handler.resolve(message.result);
        else handler.reject(Error('HA command failed: ' + (message.error?.code ?? 'unknown')));
      }
    };
  });
  return {
    fixture,
    call(type, fields = {}, timeout = 30000) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(Error('Fixture command timeout: ' + type)); }, timeout);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, type, ...fields }));
      });
    },
    async rest(route, data) {
      const response = await fetch(fixture.origin + route, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + fixture.tokens.access_token, 'Content-Type': 'application/json' },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      if (!response.ok) throw Error('Fixture HTTP failed: ' + response.status);
      return response.json();
    },
    close() { socket.close(); },
  };
}
