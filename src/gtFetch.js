// gtFetch.js — the one door every GeckoTerminal call walks through.
//
// Built 2026-10-16 on the GT-failures investigation
// (~/workspace/analysis-scratch/gt-investigation-2026-10-16.md): the old path
// (fetchJson at each call site) discarded HTTP status entirely — 429, 404,
// timeout and empty data all collapsed to the same null — single-shot with
// 12–15s timeouts and no retries anywhere, while every consumer funnels
// through one shared relay egress. ranRebuy's lookupFailed reached 109
// against 2 blocks with no way to apportion blame.
//
// This module changes NO trading decisions. It only:
//   1. classifies every GT call's outcome and counts it per consumer
//      (stats.gtOutcomes on /state, read-time attached like shadowTrades);
//   2. retries transient failures (429 / 5xx / timeout / network) with
//      jittered exponential backoff — never 404 or empty, which are answers;
//   3. paces ALL GT calls through one shared queue so candle-close bursts
//      from five consumers stop stampeding the egress at the same instant.
//
// Fail-open contract preserved exactly: a failed call resolves to null, the
// same value fetchJson returned, so every consumer's existing failure
// handling is untouched.
//
// CONFIG (env, read at call time — the relayFetch convention):
//   GT_PACE_MS       min spacing between GT call starts (default 300; 0=off)
//   GT_MAX_ATTEMPTS  attempts per logical call (default 3, clamped 1..5)
//   GT_BACKOFF_MS    backoff base; delay before attempt n+1 is
//                    base * 2^(n-1) * (0.5 + random), capped at 5s (default 350)
//   GT_ROUTE         'relay' (default) = route via the pump relay; 'direct'
//                    = straight to api.geckoterminal.com, no relay hop.
//                    Counters / retry / pacer are identical in both modes;
//                    only GT traffic is affected (pump.fun relay routing
//                    lives in relayRoutePump and is untouched by this knob).
//
// Outcome classes: ok | http429 | http404 | httpOther (see lastStatus) |
// timeout | networkError | empty (200 but no candles, OHLCV calls only) |
// partialCoverage (recorded by consumers, never by the fetch itself — the
// candles arrived but do not cover the window the consumer asked about).

import { relayRoute } from './relayFetch.js';
import { sleep } from './util.js';

export const GT_CLASSES = ['ok', 'http429', 'http404', 'httpOther', 'timeout', 'networkError', 'empty', 'partialCoverage'];

const counters = new Map(); // consumer -> tally

function tally(consumer) {
  let t = counters.get(consumer);
  if (!t) {
    t = { calls: 0, retries: 0, lastStatus: null, lastClass: null, lastAt: 0 };
    for (const c of GT_CLASSES) t[c] = 0;
    counters.set(consumer, t);
  }
  return t;
}

/** Count one outcome for a consumer. The fetch path calls this once per
 *  logical call with the FINAL class; consumers call it directly for
 *  partialCoverage, which only they can judge. */
export function recordGtOutcome(consumer, cls, { status = null, at = Date.now() } = {}) {
  const t = tally(consumer || 'unknown');
  if (GT_CLASSES.includes(cls)) t[cls]++;
  if (status != null) t.lastStatus = status;
  t.lastClass = cls;
  t.lastAt = at;
}

/** Plain-object copy for /state — mutating it cannot corrupt the tallies. */
export function gtOutcomesSnapshot() {
  const out = {};
  for (const [consumer, t] of counters) out[consumer] = { ...t };
  return out;
}

/** Test seam: wipe the tallies. */
export function _resetGtOutcomes() { counters.clear(); }

// ---------- shared pacer ----------
// A promise chain serializes call STARTS: each caller waits for the previous
// start, then holds the chain until its own start slot has passed. Starts are
// spaced >= GT_PACE_MS apart across ALL consumers; calls then run in parallel.
let paceTail = Promise.resolve();
let lastStart = 0;

function paceGapMs(env) {
  const v = Number(env && env.GT_PACE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 300;
}

async function pace(env, sleepImpl) {
  const gap = paceGapMs(env);
  if (gap <= 0) return;
  let release;
  const mine = new Promise(r => { release = r; });
  const prev = paceTail;
  paceTail = mine;
  await prev;
  try {
    const wait = lastStart + gap - Date.now();
    if (wait > 0) await sleepImpl(wait);
    lastStart = Date.now();
  } finally { release(); }
}

/** Test seam: reset pacer state so tests do not leak slots into each other. */
export function _resetGtPacer() { paceTail = Promise.resolve(); lastStart = 0; }

// ---------- classification ----------

function classifyThrow(e) {
  const name = (e && e.name) || '';
  const msg = (e && e.message) || '';
  if (name === 'TimeoutError' || name === 'AbortError' || /timed?\s*out|abort/i.test(msg)) return 'timeout';
  return 'networkError';
}

function isRetryable(cls, status) {
  if (cls === 'http429' || cls === 'timeout' || cls === 'networkError') return true;
  if (cls === 'httpOther') return status === 408 || (status >= 500 && status <= 599);
  return false; // ok, http404, empty are answers, not transients
}

/**
 * One logical GeckoTerminal GET with outcome counting, shared pacing and
 * bounded retries. `url` is the RAW GT URL — relay routing is applied here.
 * opts: { consumer, timeout, headers, expect: 'ohlcv' (classifies a 200 with
 * an empty candle list as 'empty'), env, fetchImpl, sleepImpl } — the last
 * three are test seams. Resolves to the parsed JSON, or null on failure
 * (exactly the fetchJson contract the call sites were written against).
 */
export async function fetchGtJson(url, opts = {}) {
  const {
    consumer = 'unknown', timeout = 12000, headers = {}, expect = null,
    env = process.env, fetchImpl = null, sleepImpl = sleep,
  } = opts;
  const doFetch = fetchImpl || fetch;
  const t = tally(consumer);
  t.calls++;
  const maxAttempts = (() => {
    const v = Math.floor(Number(env && env.GT_MAX_ATTEMPTS));
    return Number.isFinite(v) ? Math.min(5, Math.max(1, v)) : 3;
  })();
  const backoffBase = (() => {
    const v = Number(env && env.GT_BACKOFF_MS);
    return Number.isFinite(v) && v >= 0 ? v : 350;
  })();
  const gtDirect = String((env && env.GT_ROUTE) || '').toLowerCase() === 'direct';
  const { url: routedUrl, headers: relayHeaders } = gtDirect ? { url, headers: {} } : relayRoute(url, env);
  const mergedHeaders = { accept: 'application/json', 'user-agent': 'edgebot/1.0', ...relayHeaders, ...headers };

  let cls = 'networkError', status = null, json = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await pace(env, sleepImpl);
    status = null; json = null;
    try {
      const r = await doFetch(routedUrl, { method: 'GET', headers: mergedHeaders, signal: AbortSignal.timeout(timeout) });
      status = r.status;
      if (status === 429) cls = 'http429';
      else if (status === 404) cls = 'http404';
      else if (!r.ok) cls = 'httpOther';
      else {
        try { json = await r.json(); cls = 'ok'; }
        catch (e) { cls = 'networkError'; status = null; }
        if (cls === 'ok' && expect === 'ohlcv') {
          const list = json && json.data && json.data.attributes && json.data.attributes.ohlcv_list;
          if (!Array.isArray(list) || !list.length) cls = 'empty';
        }
      }
    } catch (e) {
      cls = classifyThrow(e);
      status = null;
    }
    if (cls === 'ok' || cls === 'empty') break;
    if (!isRetryable(cls, status) || attempt === maxAttempts) break;
    t.retries++;
    const delay = Math.min(5000, backoffBase * 2 ** (attempt - 1) * (0.5 + Math.random()));
    if (delay > 0) await sleepImpl(delay);
  }
  recordGtOutcome(consumer, cls, { status });
  return cls === 'ok' || cls === 'empty' ? json : null;
}
