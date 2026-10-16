import test from 'node:test';
import assert from 'node:assert/strict';
import { relayRoute, GT_HOST } from '../src/relayFetch.js';

const GT_URL = 'https://api.geckoterminal.com/api/v2/networks/solana/tokens/So11111111111111111111111111111111111111112';

test('relay unset -> original URL, no relay header', () => {
  const r = relayRoute(GT_URL, {});
  assert.equal(r.url, GT_URL);
  assert.deepEqual(r.headers, {});
  assert.ok(!('x-relay-key' in r.headers));
});

test('relay unset even when only the key is set -> original URL, no relay header', () => {
  const r = relayRoute(GT_URL, { PUMP_RELAY_KEY: 'k' });
  assert.equal(r.url, GT_URL);
  assert.deepEqual(r.headers, {});
});

test('relay set + key -> relay URL with encoded url param and x-relay-key header', () => {
  const r = relayRoute(GT_URL, { PUMP_RELAY: 'https://w.dev/', PUMP_RELAY_KEY: 'k' });
  assert.equal(r.url, `https://w.dev/?url=${encodeURIComponent(GT_URL)}`);
  assert.equal(r.headers['x-relay-key'], 'k');
});

test('relay set without key -> relay URL, no key header', () => {
  const r = relayRoute(GT_URL, { PUMP_RELAY: 'https://w.dev/' });
  assert.equal(r.url, `https://w.dev/?url=${encodeURIComponent(GT_URL)}`);
  assert.deepEqual(r.headers, {});
  assert.ok(!('x-relay-key' in r.headers));
});

test('relay URL already carrying a query string joins with &', () => {
  const r = relayRoute(GT_URL, { PUMP_RELAY: 'https://w.dev/?a=1', PUMP_RELAY_KEY: 'k' });
  assert.equal(r.url, `https://w.dev/?a=1&url=${encodeURIComponent(GT_URL)}`);
});

test('GT query params survive encoding intact (no & leakage into the relay URL)', () => {
  const u = 'https://api.geckoterminal.com/api/v2/networks/solana/pools/P/ohlcv/minute?limit=1000&before_timestamp=42';
  const r = relayRoute(u, { PUMP_RELAY: 'https://w.dev/' });
  assert.equal(new URL(r.url).searchParams.get('url'), u);
});

test('non-GT URL is never rewritten, even with the relay set', () => {
  const u = 'https://api.dexscreener.com/latest/dex/tokens/X';
  const r = relayRoute(u, { PUMP_RELAY: 'https://w.dev/', PUMP_RELAY_KEY: 'k' });
  assert.equal(r.url, u);
  assert.deepEqual(r.headers, {});
  assert.equal(GT_HOST, 'api.geckoterminal.com');
});

test('default env is process.env, read at call time', () => {
  const savedRelay = process.env.PUMP_RELAY;
  const savedKey = process.env.PUMP_RELAY_KEY;
  try {
    delete process.env.PUMP_RELAY; delete process.env.PUMP_RELAY_KEY;
    assert.equal(relayRoute(GT_URL).url, GT_URL);
    process.env.PUMP_RELAY = 'https://w.dev/'; process.env.PUMP_RELAY_KEY = 'k';
    const r = relayRoute(GT_URL);
    assert.ok(r.url.startsWith('https://w.dev/?url='));
    assert.equal(r.headers['x-relay-key'], 'k');
  } finally {
    if (savedRelay === undefined) delete process.env.PUMP_RELAY; else process.env.PUMP_RELAY = savedRelay;
    if (savedKey === undefined) delete process.env.PUMP_RELAY_KEY; else process.env.PUMP_RELAY_KEY = savedKey;
  }
});
