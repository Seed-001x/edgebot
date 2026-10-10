import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPumpList, listState } from '../src/pumpLists.js';
test('records Cloudflare block diagnostics', async () => {
  const f = async () => ({ ok: false, status: 403, headers: new Map([['server', 'cloudflare'], ['cf-mitigated', 'challenge']]), text: async () => '<html>Just a moment...</html>' });
  assert.deepEqual(await fetchPumpList('t', 'https://x', { fetchImpl: f, env: {} }), []);
  const s = listState().t;
  assert.equal(s.status, 403); assert.match(s.err, /Cloudflare/); assert.match(s.bodyHead, /Just a moment/);
});
test('relay rewrites target and sends key', async () => {
  let u, h;
  const f = async (url, o) => { u = url; h = o.headers; return { ok: true, status: 200, headers: new Map(), json: async () => [] }; };
  await fetchPumpList('r', 'https://frontend-api-v3.pump.fun/coins?a=1', { fetchImpl: f, env: { PUMP_RELAY: 'https://w.dev/', PUMP_RELAY_KEY: 'k' } });
  assert.ok(u.startsWith('https://w.dev/?url=https%3A%2F%2Ffrontend')); assert.equal(h['x-relay-key'], 'k');
});
