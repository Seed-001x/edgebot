// gtFetch — the GT door (2026-10-16, GT-failures investigation fix):
// outcome classification per consumer, retry-with-backoff on transients only,
// one shared pacer across consumers, and the fail-open null contract the call
// sites were written against. All fetches are stubbed; env knobs are passed
// explicitly so the suite never waits on real pacing/backoff.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGtJson, recordGtOutcome, gtOutcomesSnapshot, _resetGtOutcomes, _resetGtPacer } from '../src/gtFetch.js';

const GT_URL = 'https://api.geckoterminal.com/api/v2/networks/solana/pools/P/ohlcv/minute?limit=1000&before_timestamp=42';
const FAST = { GT_PACE_MS: '0', GT_BACKOFF_MS: '1', GT_MAX_ATTEMPTS: '3' };

function reset() { _resetGtOutcomes(); _resetGtPacer(); }

const resp = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const candles = (n = 2) => ({ data: { attributes: { ohlcv_list: Array.from({ length: n }, (_, i) => [1000 + i * 60, 1, 2, 0.5, 1.5, 10]) } } });

function stubSeq(seq) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const next = seq[Math.min(calls.length - 1, seq.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

test('gtfetch: 200 with candles -> json returned, ok counted once, raw URL direct when no relay env', async () => {
  reset();
  const f = stubSeq([resp(200, candles())]);
  const j = await fetchGtJson(GT_URL, { consumer: 'ranRebuy', expect: 'ohlcv', env: FAST, fetchImpl: f });
  assert.deepEqual(j, candles());
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, GT_URL);
  const s = gtOutcomesSnapshot().ranRebuy;
  assert.equal(s.ok, 1); assert.equal(s.calls, 1); assert.equal(s.retries, 0); assert.equal(s.lastStatus, 200);
});

test('gtfetch: relay env routes through the relay with the key header', async () => {
  reset();
  const f = stubSeq([resp(200, candles())]);
  const env = { ...FAST, PUMP_RELAY: 'https://w.dev/', PUMP_RELAY_KEY: 'k' };
  await fetchGtJson(GT_URL, { consumer: 'structureWatch', expect: 'ohlcv', env, fetchImpl: f });
  assert.equal(f.calls[0].url, `https://w.dev/?url=${encodeURIComponent(GT_URL)}`);
  assert.equal(f.calls[0].opts.headers['x-relay-key'], 'k');
});

test('gtfetch: 429 is retried and a later success is the final class', async () => {
  reset();
  const f = stubSeq([resp(429), resp(429), resp(200, candles())]);
  const j = await fetchGtJson(GT_URL, { consumer: 'calloutTailer', expect: 'ohlcv', env: FAST, fetchImpl: f });
  assert.deepEqual(j, candles());
  assert.equal(f.calls.length, 3);
  const s = gtOutcomesSnapshot().calloutTailer;
  assert.equal(s.ok, 1); assert.equal(s.http429, 0, 'only the final outcome is booked');
  assert.equal(s.retries, 2); assert.equal(s.calls, 1);
});

test('gtfetch: persistent 429 exhausts attempts, resolves null, books http429', async () => {
  reset();
  const f = stubSeq([resp(429)]);
  const j = await fetchGtJson(GT_URL, { consumer: 'ranRebuy', expect: 'ohlcv', env: FAST, fetchImpl: f });
  assert.equal(j, null);
  assert.equal(f.calls.length, 3, 'GT_MAX_ATTEMPTS total attempts');
  const s = gtOutcomesSnapshot().ranRebuy;
  assert.equal(s.http429, 1); assert.equal(s.retries, 2); assert.equal(s.lastStatus, 429);
});

test('gtfetch: 404 is an answer — no retry, books http404, resolves null', async () => {
  reset();
  const f = stubSeq([resp(404)]);
  const j = await fetchGtJson(GT_URL, { consumer: 'walletWatch', env: FAST, fetchImpl: f });
  assert.equal(j, null);
  assert.equal(f.calls.length, 1);
  assert.equal(gtOutcomesSnapshot().walletWatch.http404, 1);
});

test('gtfetch: 5xx retries as httpOther; other 4xx does not retry', async () => {
  reset();
  const f5 = stubSeq([resp(503), resp(200, candles())]);
  await fetchGtJson(GT_URL, { consumer: 'structureWatch', expect: 'ohlcv', env: FAST, fetchImpl: f5 });
  assert.equal(f5.calls.length, 2);
  assert.equal(gtOutcomesSnapshot().structureWatch.ok, 1);
  const f4 = stubSeq([resp(400)]);
  const j = await fetchGtJson(GT_URL, { consumer: 'structureWatch', env: FAST, fetchImpl: f4 });
  assert.equal(j, null);
  assert.equal(f4.calls.length, 1, 'a 400 is not transient');
  const s = gtOutcomesSnapshot().structureWatch;
  assert.equal(s.httpOther, 1); assert.equal(s.lastStatus, 400);
});

test('gtfetch: timeouts and network throws classify and retry', async () => {
  reset();
  const timeoutErr = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
  const f = stubSeq([timeoutErr, resp(200, candles())]);
  await fetchGtJson(GT_URL, { consumer: 'ranRebuy', expect: 'ohlcv', env: FAST, fetchImpl: f });
  assert.equal(f.calls.length, 2);
  assert.equal(gtOutcomesSnapshot().ranRebuy.ok, 1);
  const f2 = stubSeq([new TypeError('fetch failed')]);
  const j = await fetchGtJson(GT_URL, { consumer: 'ranRebuy', env: FAST, fetchImpl: f2 });
  assert.equal(j, null);
  assert.equal(f2.calls.length, 3);
  assert.equal(gtOutcomesSnapshot().ranRebuy.networkError, 1);
});

test('gtfetch: 200 with an empty candle list books empty (no retry) and still returns the body', async () => {
  reset();
  const empty = { data: { attributes: { ohlcv_list: [] } } };
  const f = stubSeq([resp(200, empty)]);
  const j = await fetchGtJson(GT_URL, { consumer: 'calloutTailer', expect: 'ohlcv', env: FAST, fetchImpl: f });
  assert.deepEqual(j, empty, 'consumers break their paging loop on the empty list, as before');
  assert.equal(f.calls.length, 1);
  assert.equal(gtOutcomesSnapshot().calloutTailer.empty, 1);
});

test('gtfetch: the pacer spaces call starts across consumers; GT_PACE_MS=0 disables it', async () => {
  reset();
  const starts = [];
  const f = async () => { starts.push(Date.now()); return resp(200, candles()); };
  const env = { GT_PACE_MS: '50', GT_BACKOFF_MS: '1', GT_MAX_ATTEMPTS: '1' };
  await Promise.all([
    fetchGtJson(GT_URL, { consumer: 'a', env, fetchImpl: f }),
    fetchGtJson(GT_URL, { consumer: 'b', env, fetchImpl: f }),
    fetchGtJson(GT_URL, { consumer: 'c', env, fetchImpl: f }),
  ]);
  assert.equal(starts.length, 3);
  const sorted = [...starts].sort((x, y) => x - y);
  assert.ok(sorted[1] - sorted[0] >= 40, `second start spaced (got ${sorted[1] - sorted[0]}ms)`);
  assert.ok(sorted[2] - sorted[1] >= 40, `third start spaced (got ${sorted[2] - sorted[1]}ms)`);
  reset();
  starts.length = 0;
  await Promise.all([
    fetchGtJson(GT_URL, { consumer: 'a', env: FAST, fetchImpl: f }),
    fetchGtJson(GT_URL, { consumer: 'b', env: FAST, fetchImpl: f }),
  ]);
  assert.ok(Math.abs(starts[1] - starts[0]) < 40, 'no spacing when the pacer is off');
});

test('gtfetch: recordGtOutcome books consumer-judged classes; snapshot is an isolated copy', async () => {
  reset();
  recordGtOutcome('ranRebuy', 'partialCoverage');
  recordGtOutcome('ranRebuy', 'partialCoverage');
  const s = gtOutcomesSnapshot();
  assert.equal(s.ranRebuy.partialCoverage, 2);
  assert.equal(s.ranRebuy.lastClass, 'partialCoverage');
  s.ranRebuy.partialCoverage = 999;
  assert.equal(gtOutcomesSnapshot().ranRebuy.partialCoverage, 2, 'mutating the snapshot cannot corrupt the tallies');
});
