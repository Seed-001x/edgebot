// calloutLab.js — Callout Shadow Lab (user 2026-10-15, RECORD-ONLY).
//
// Live pump.fun callouts are OFF (cfg.calloutsEnabled / CALLOUTS_ENABLED) while
// the new Callout Rewards rules judge callers by follower PnL at +1h/+4h. This
// lab answers "would our calls have made followers money?" without posting
// anything: at every moment the bot WOULD have called (an entry, a TP1/TP2
// bank, a moonbag close, a wallet-detector event, a graduation) it journals a
// would-call record to callout_shadow.jsonl, then scores each call later off
// GeckoTerminal minute candles with the exact tailer method from the
// 2026-10-15 tailer report: entryRef = close of the candle containing
// callTs+2min; r1h/r4h/r24h = closes at +60m/+240m/+1440m ÷ entryRef − 1;
// peaks = max candle high inside (callTs+2m, horizon].
//
// HARD BOUNDARIES: this module never posts, never signs, never touches
// positions or orders. Every public method is fail-silent — a lab failure can
// never reach a trading path. Thesis text comes from callout.js buildThesis
// (the same text a live post would carry); generation failure records
// thesis:null with a thesisSource note instead of throwing.
import fs from 'node:fs';
import { fetchJson, mean, median, round } from './util.js';
import { buildThesis } from './callout.js';

export const CALLOUT_TRIGGERS = ['entry', 'tp1', 'tp2', 'tp3', 'confluence', 'devlaunch', 'graduation'];
export const FIRST3_BASIS = 'first3 = the chronologically first 3 would-calls of each America/New_York calendar day across ALL trigger types (dedupe already applied: one record per mint per trigger type, ever). No liquidity floor — the floor is parked scope and is not part of this simulation. Aggregates are over the scored subset; pending counts calls whose scores are not in yet.';

const GT = 'https://api.geckoterminal.com/api/v2';
const HORIZONS = [60, 240, 1440]; // minutes — the rewards horizons (+24h for the full picture)
const RKEY = { 60: 'r1h', 240: 'r4h', 1440: 'r24h' };
const PKEY = { 60: 'peak1h', 240: 'peak4h', 1440: 'peak24h' };
const ENTRY_LAG_MS = 2 * 60000;   // a follower cannot fill at the call print; entry is the +2m candle close
const NEAR_MS = 3 * 60000;        // nearest-candle tolerance ±3 min (noted when used)
const AGE_OUT_MS = 72 * 3600e3;   // stop retrying a horizon after 72h; finalize partial
const TICK_MIN_MS = 60000;        // scorer cadence floor (rides the bot's slow tick)
const PER_TICK_MAX = 4;           // GT pacing: at most this many records scored per tick
const CARD_CACHE_MS = 60000;

// ---------- pure scoring math (tested directly) ----------

/** Close of the candle containing targetMs; failing that, the close of the
 *  nearest-starting candle within ±3 min (flagged approx); else null. */
function closeAt(cs, targetMs) {
  let best = null, bestDist = Infinity;
  for (const c of cs) {
    const start = c[0] * 1000;
    if (targetMs >= start && targetMs < start + 60000) return { close: c[4], approx: false };
    const d = Math.abs(start - targetMs);
    if (d < bestDist) { bestDist = d; best = c; }
  }
  if (best && bestDist <= NEAR_MS) return { close: best[4], approx: true };
  return null;
}

/** Tailer score for one would-call from minute candles [[tsSec,o,h,l,c,v],…].
 *  entryRef is sticky: pass a previously computed one so later horizons stay
 *  on the same basis even if early candles age out of a later fetch. Missing
 *  data stays null — never fabricated. */
export function computeTailerScore(candles, callTs, stickyEntryRef = null) {
  const cs = [...(candles || [])].sort((a, b) => a[0] - b[0]);
  const notes = [];
  let entryRef = stickyEntryRef != null ? stickyEntryRef : null;
  if (entryRef == null) {
    const e = closeAt(cs, callTs + ENTRY_LAG_MS);
    if (e) { entryRef = e.close; if (e.approx) notes.push('entryRef:nearest'); }
  }
  const out = { entryRef, r1h: null, r4h: null, r24h: null, peak1h: null, peak4h: null, peak24h: null, notes };
  if (entryRef == null || !(entryRef > 0)) return out;
  for (const h of HORIZONS) {
    const rk = RKEY[h], pk = PKEY[h];
    const c = closeAt(cs, callTs + h * 60000);
    if (c) { out[rk] = c.close / entryRef - 1; if (c.approx) notes.push(`${rk}:nearest`); }
    let peak = null;
    for (const cd of cs) {
      const start = cd[0] * 1000;
      if (start > callTs + ENTRY_LAG_MS && start <= callTs + h * 60000) {
        if (peak == null || cd[2] > peak) peak = cd[2];
      }
    }
    if (peak != null) out[pk] = peak / entryRef - 1;
  }
  return out;
}

// ---------- pure scorecard (tested directly) ----------

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
export const nyDay = (ts) => dayFmt.format(new Date(ts));

/** Fold raw journal lines into [{call, score}] pairs (latest score per call). */
export function foldCalloutJournal(records) {
  const calls = new Map(), scores = new Map();
  for (const r of records || []) {
    if (!r) continue;
    if (r.kind === 'would-call' && r.id) { if (!calls.has(r.id)) calls.set(r.id, r); }
    else if (r.kind === 'score' && r.id) scores.set(r.id, r);
  }
  return [...calls.values()].map(c => ({ call: c, score: scores.get(c.id) || null }));
}

function agg(pairs) {
  const scored = pairs.filter(p => p.score && p.score.entryRef != null);
  const vals = (k) => scored.map(p => p.score[k]).filter(Number.isFinite);
  const r1 = vals('r1h'), r4 = vals('r4h'), r24 = vals('r24h');
  const share = (a) => (a.length ? a.filter(x => x > 0).length / a.length : null);
  return {
    n: scored.length,
    pending: pairs.length - scored.length,
    medianR1h: round(median(r1)), meanR1h: round(mean(r1)),
    medianR4h: round(median(r4)), meanR4h: round(mean(r4)),
    medianR24h: round(median(r24)), meanR24h: round(mean(r24)),
    sharePositive1h: round(share(r1)), sharePositive4h: round(share(r4)),
    bestR4h: r4.length ? round(Math.max(...r4)) : null,
    worstR4h: r4.length ? round(Math.min(...r4)) : null,
  };
}

function readyFor(pairs, now) {
  const a = agg(pairs);
  const cutoff = now - 14 * 86400e3;
  const ra = agg(pairs.filter(p => p.call.ts >= cutoff));
  const ready = a.n >= 30 && a.medianR1h > 0 && a.medianR4h > 0 && ra.medianR1h > 0 && ra.medianR4h > 0;
  return {
    ready,
    last14n: ra.n, last14MedianR1h: ra.medianR1h, last14MedianR4h: ra.medianR4h,
    readyBasis: `ready = n>=30 (n=${a.n}) AND median r1h>0 (${a.medianR1h}) AND median r4h>0 (${a.medianR4h}) AND trailing-14d subset alone (n=${ra.n}) median r1h>0 (${ra.medianR1h}) AND median r4h>0 (${ra.medianR4h})`,
  };
}

export function calloutScorecard(pairs, now) {
  const byTrigger = {};
  for (const t of CALLOUT_TRIGGERS) byTrigger[t] = [];
  for (const p of pairs) (byTrigger[p.call.trigger] = byTrigger[p.call.trigger] || []).push(p);
  const perTrigger = {};
  for (const t of Object.keys(byTrigger)) perTrigger[t] = { ...agg(byTrigger[t]), ...readyFor(byTrigger[t], now) };

  const dayMap = new Map();
  for (const p of pairs) {
    const key = nyDay(p.call.ts) + '|' + p.call.trigger;
    if (!dayMap.has(key)) dayMap.set(key, { day: nyDay(p.call.ts), trigger: p.call.trigger, items: [] });
    dayMap.get(key).items.push(p);
  }
  const daily = [...dayMap.values()]
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.trigger < b.trigger ? -1 : 1))
    .map(d => ({ day: d.day, trigger: d.trigger, ...agg(d.items) }));

  const chrono = [...pairs].sort((a, b) => a.call.ts - b.call.ts);
  const perDay = new Map();
  for (const p of chrono) {
    const d = nyDay(p.call.ts);
    if (!perDay.has(d)) perDay.set(d, []);
    const arr = perDay.get(d);
    if (arr.length < 3) arr.push(p);
  }
  const first3Pairs = [...perDay.values()].flat();
  const first3 = { ...agg(first3Pairs), days: perDay.size, callsConsidered: pairs.length };

  const recent = [...pairs].sort((a, b) => b.call.ts - a.call.ts).slice(0, 15).map(p => ({
    id: p.call.id, ts: p.call.ts, trigger: p.call.trigger, mint: p.call.mint, symbol: p.call.symbol,
    thesis: p.call.thesis != null ? p.call.thesis : null, mc: p.call.mc != null ? p.call.mc : null,
    liquidity: p.call.liquidity != null ? p.call.liquidity : null, holding: !!p.call.holding,
    linkId: p.call.linkId || null,
    score: p.score ? {
      entryRef: p.score.entryRef, r1h: p.score.r1h, r4h: p.score.r4h, r24h: p.score.r24h,
      peak1h: p.score.peak1h, peak4h: p.score.peak4h, peak24h: p.score.peak24h,
      final: !!p.score.final, partial: !!p.score.partial,
    } : null,
  }));

  return { perTrigger, daily, first3, first3Basis: FIRST3_BASIS, recent };
}

// ---------- default GeckoTerminal access (injectable for tests) ----------

async function defaultFetchCandles(pool, fromTs, toTs) {
  const byTs = new Map();
  let before = Math.floor(toTs / 1000) + 60;
  for (let page = 0; page < 4; page++) {
    const j = await fetchJson(`${GT}/networks/solana/pools/${pool}/ohlcv/minute?limit=1000&before_timestamp=${before}`, { timeout: 15000 });
    const list = j && j.data && j.data.attributes && j.data.attributes.ohlcv_list;
    if (!list || !list.length) break;
    let oldest = Infinity;
    for (const row of list) { byTs.set(row[0], row); if (row[0] < oldest) oldest = row[0]; }
    if (oldest * 1000 <= fromTs || list.length < 1000) break;
    before = oldest - 1;
  }
  return [...byTs.values()].sort((a, b) => a[0] - b[0]);
}

async function defaultResolvePool(mint) {
  const j = await fetchJson(`${GT}/networks/solana/tokens/${mint}`, { timeout: 12000 });
  const pools = j && j.data && j.data.relationships && j.data.relationships.top_pools && j.data.relationships.top_pools.data;
  if (!pools || !pools.length) return null;
  const id = String(pools[0].id || '');
  return id.startsWith('solana_') ? id.slice('solana_'.length) : (id || null);
}

// ---------- the lab ----------

export class CalloutLab {
  constructor({ cfg = {}, journal = null, now = () => Date.now(), buildThesisFn = null, fetchCandles = null, resolvePool = null } = {}) {
    this.cfg = cfg;
    this.journal = journal;
    this.now = now;
    this.buildThesisFn = buildThesisFn || buildThesis;
    this.fetchCandles = fetchCandles || defaultFetchCandles;
    this.resolvePool = resolvePool || defaultResolvePool;
    this.seen = new Set();       // `${trigger}:${mint}` — dedupe; rebuilt at boot from the journal itself
    this.calls = new Map();       // would-call id -> { rec, score, attempted:Set, nextTry, final }
    this.poolCache = new Map();
    this.seq = 0;
    this.lastTick = 0;
    this.cardCache = null;
    this.cardCacheTs = 0;
    this._restore();
  }

  _file() { return this.journal && this.journal.f ? this.journal.f.cshadow : null; }

  _readAll() {
    const f = this._file();
    if (!f) return [];
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn tail line — skip */ }
    }
    return out;
  }

  _newState(rec) { return { rec, score: null, attempted: new Set(), nextTry: 0, final: false }; }

  _restore() {
    for (const r of this._readAll()) {
      if (!r) continue;
      if (r.kind === 'would-call' && r.id) {
        this.seen.add(`${r.trigger}:${r.mint}`);
        if (!this.calls.has(r.id)) this.calls.set(r.id, this._newState(r));
      } else if (r.kind === 'score' && r.id && this.calls.has(r.id)) {
        const st = this.calls.get(r.id);
        st.score = r;
        st.final = !!r.final;
        st.attempted = new Set(Array.isArray(r.stages) ? r.stages : (r.final ? HORIZONS : HORIZONS.filter(h => r[RKEY[h]] != null || r[PKEY[h]] != null)));
      }
    }
  }

  /** Journal one would-call. Fire-and-forget safe: never throws, never blocks
   *  a trading path (callers do not await it). The dedupe key is claimed in
   *  the synchronous prologue — before the first await — so two triggers in
   *  the same tick cannot double-record. Returns the record or null. */
  async record(spec) {
    try {
      if (!spec || !spec.trigger || !spec.mint) return null;
      const key = `${spec.trigger}:${spec.mint}`;
      if (this.seen.has(key)) return null;
      this.seen.add(key);
      const ts = spec.ts || this.now();
      const id = `wc-${spec.trigger}-${ts}-${++this.seq}`;
      const v = spec.v || { address: spec.mint, symbol: spec.symbol || null, name: spec.symbol || null, mc: spec.mc != null ? spec.mc : null };
      let thesis = null, thesisSource = 'buildThesis';
      try {
        thesis = await this.buildThesisFn(v, spec.sig || { setup: spec.setup || spec.trigger });
        if (!thesis) thesisSource = 'buildThesis-empty';
      } catch { thesis = null; thesisSource = 'buildThesis-failed'; }
      const rec = {
        kind: 'would-call', id, ts, trigger: spec.trigger, mint: spec.mint,
        symbol: spec.symbol != null ? spec.symbol : (v.symbol || null),
        thesis: thesis || null, thesisSource,
        mc: spec.mc != null ? spec.mc : (v.mc != null ? v.mc : null),
        liquidity: spec.liquidity != null ? spec.liquidity : (v.liq != null ? v.liq : null),
        pool: spec.pool || v.pairAddress || null,
        setup: spec.setup || null, source: spec.source || null,
        holding: !!spec.holding,
        linkId: spec.linkId || null,
      };
      if (this.journal) this.journal.calloutShadow(rec);
      this.calls.set(id, this._newState(rec));
      return rec;
    } catch { return null; }
  }

  _due(st, n) {
    const age = n - st.rec.ts;
    if (age > AGE_OUT_MS) return true;
    for (const h of HORIZONS) if (!st.attempted.has(h) && age >= h * 60000 + ENTRY_LAG_MS) return true;
    return false;
  }

  /** Scorer pass — rides the bot's slow tick, self-throttled, capped per tick
   *  for GT rate limits. Fail-silent: scoring can never disturb trading. */
  async tick(n = this.now()) {
    try {
      if (n - this.lastTick < TICK_MIN_MS) return;
      this.lastTick = n;
      let worked = 0;
      for (const st of this.calls.values()) {
        if (worked >= PER_TICK_MAX) break;
        if (st.final || n < st.nextTry || !this._due(st, n)) continue;
        worked++;
        await this._scoreOne(st, n).catch(() => {});
      }
    } catch { /* shadow lab — fail silent */ }
  }

  _appendScore(st, n, patch) {
    const prev = st.score || {};
    const pick = (k) => (patch[k] !== undefined ? patch[k] : (prev[k] != null ? prev[k] : null));
    const rec = {
      kind: 'score', id: st.rec.id, ts: n, trigger: st.rec.trigger, mint: st.rec.mint,
      pool: patch.pool !== undefined ? patch.pool : (prev.pool || null),
      entryRef: pick('entryRef'), r1h: pick('r1h'), r4h: pick('r4h'), r24h: pick('r24h'),
      peak1h: pick('peak1h'), peak4h: pick('peak4h'), peak24h: pick('peak24h'),
      notes: patch.notes || prev.notes || [],
      stages: patch.stages || [...st.attempted].sort((a, b) => a - b),
      partial: !!patch.partial, final: !!patch.final,
    };
    if (this.journal) this.journal.calloutShadow(rec);
    st.score = rec;
    st.final = rec.final;
    return rec;
  }

  async _scoreOne(st, n) {
    const rec = st.rec;
    const agedOut = n - rec.ts > AGE_OUT_MS;
    let pool = rec.pool || this.poolCache.get(rec.mint) || null;
    if (!pool) {
      try { pool = await this.resolvePool(rec.mint); } catch { pool = null; }
      if (pool) this.poolCache.set(rec.mint, pool);
    }
    if (!pool) {
      st.nextTry = n + 10 * 60000;
      if (agedOut && !st.final) this._appendScore(st, n, { pool: null, notes: ['no-pool'], partial: true, final: true });
      return;
    }
    const dueH = HORIZONS.filter(h => n - rec.ts >= h * 60000 + ENTRY_LAG_MS);
    const maxDue = dueH.length ? Math.max(...dueH) : 0;
    const toTs = Math.min(n, rec.ts + Math.max(maxDue * 60000, ENTRY_LAG_MS) + 5 * 60000);
    let candles = null;
    try { candles = await this.fetchCandles(pool, rec.ts - 60000, toTs); } catch { candles = null; }
    if (!candles || !candles.length) {
      // No data yet (dead coin, GT gap): do NOT burn the stages — retry until
      // the 72h age-out finalizes the record partial.
      st.nextTry = n + 10 * 60000;
      if (agedOut && !st.final) this._appendScore(st, n, { pool, notes: ['no-candles'], partial: true, final: true });
      return;
    }
    const s = computeTailerScore(candles, rec.ts, st.score ? st.score.entryRef : null);
    for (const h of dueH) st.attempted.add(h);
    // A horizon is only PUBLISHED once its moment has actually arrived — the
    // score never leans on a fetcher returning candles past the due window.
    for (const h of HORIZONS) if (!st.attempted.has(h)) { s[RKEY[h]] = null; s[PKEY[h]] = null; }
    const final = agedOut || HORIZONS.every(h => st.attempted.has(h));
    const partial = s.entryRef == null || HORIZONS.some(h => st.attempted.has(h) && s[RKEY[h]] == null);
    this._appendScore(st, n, { pool, ...s, stages: [...st.attempted].sort((a, b) => a - b), partial, final });
    if (!final) st.nextTry = n + 60000;
  }

  /** GET /callouts payload. Computed from the FULL journal file (never a
   *  capped in-memory tail — the readiness windows span 14 days), ~60s cache. */
  scorecard() {
    const n = this.now();
    if (this.cardCache && n - this.cardCacheTs < CARD_CACHE_MS) return this.cardCache;
    const records = this._readAll();
    const pairs = foldCalloutJournal(records);
    const card = {
      enabled: true, // the lab is record-only and always on; liveCallouts is the separate live-post gate
      liveCallouts: !!(this.cfg && this.cfg.calloutsEnabled),
      generatedTs: n,
      journalRecords: records.length,
      wouldCalls: pairs.length,
      ...calloutScorecard(pairs, n),
    };
    this.cardCache = card;
    this.cardCacheTs = n;
    return card;
  }
}
