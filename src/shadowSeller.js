// shadowSeller.js — the LEARNED shadow seller (user order 2026-10-16,
// RECORD-ONLY — this module can never sell, gate, or touch live logic).
//
// The user's brief: "take this path shadow mode, it'll no longer work under
// restraints — it'll make its own decision based on everything it needs to
// make the most accurate measure." So this judge carries NO ladder rules and
// NO borrowed thresholds. It learns from the bot's own completed history:
//
//   EVIDENCE — every closed position leaves a tick path (ticks.jsonl, ~10s
//   samples: valueSol / ratio / peak / flow) and a sell decomposition
//   (trades journal: each sell's solOut). For every historical tick, the
//   payoff of HOLDING from that exact state to the position's eventual exit
//   is computable exactly: holdNet = (Σ solOut of sells after the tick)
//   − fee × (number of those sells); the sell-now alternative was the
//   tick's own realizable mark − one fee. payoffDiff per unit of mark =
//   (holdNet − shadowNet) / mark. Ticks are discretized into the bucket
//   grid below and each bucket accumulates the mean payoffDiff, smoothed
//   toward ZERO (no opinion) by a prior of PRIOR_K phantom samples:
//   EV = Σdiff / (n + PRIOR_K). A bucket with little or no evidence can
//   never fire — absence of evidence reads as HOLD, always.
//
//   DECISION — on every position check, the live position's state is
//   bucketed the same way; the judge WOULD-SELL (once per position, the
//   first time) when its bucket has n >= MIN_N samples and EV < 0 — the
//   states where, historically, holding from there paid worse than the
//   mark on the table. The fire is journaled with the full state snapshot.
//
//   SCORING — when the position actually closes (Bot.ensureClose, the one
//   funnel every close passes through), the fire is paired: the shadow's
//   net (fire-time realizable remainder value − one sell fee) vs the
//   ladder's actual net on that same remainder from fire time to close
//   (close proceeds − what was already realized at fire − the sell fees
//   the ladder paid after the fire). deltaSol > 0 = the shadow was right.
//   /shadowseller serves the card; ready = 30 paired fires.
//
// The table refits from the journal on boot and every REFIT_MIN minutes
// (checked lazily on the observe path), so it sharpens as exits accumulate.
// Kill switch: SHADOW_SELLER=0 disables entirely (no observing, no records).
import fs from 'node:fs';
import path from 'node:path';
import { round } from './util.js';

// ------------------------------------------------------------ the bucket grid
// THE grid — the single place state is discretized (v1, per the brief):
// peak band (peakRatio, ratio space — the realizable value of the remainder
// vs its cost basis, floored at 1, exactly as journaled on ticks) × drawdown
// band (ratio / peakRatio − 1) × buy-share-trend sign (share of buys in the
// 5m flow now vs ~90s ago, the position's own series — the same trend
// exits.js computes for the TP1 strength test).
export const PEAK_BANDS = [
  { key: 'p<1.1', test: p => p < 1.1 },
  { key: 'p1.1-1.3', test: p => p >= 1.1 && p < 1.3 },
  { key: 'p1.3-1.6', test: p => p >= 1.3 && p < 1.6 },
  { key: 'p1.6-2.2', test: p => p >= 1.6 && p < 2.2 },
  { key: 'p>=2.2', test: p => p >= 2.2 },
];
export const DD_BANDS = [
  { key: 'dd0-5', test: d => d > -0.05 },
  { key: 'dd5-12', test: d => d <= -0.05 && d > -0.12 },
  { key: 'dd12-25', test: d => d <= -0.12 && d > -0.25 },
  { key: 'dd>25', test: d => d <= -0.25 },
];
export const TREND_DEADBAND = 0.02; // |shareTrend| inside this reads 'flat', not a direction

export function peakBand(peakRatio) {
  if (!(peakRatio > 0)) return 'p<1.1';
  for (const b of PEAK_BANDS) if (b.test(peakRatio)) return b.key;
  return 'p>=2.2';
}
export function drawdownBand(dd) {
  if (dd == null || !Number.isFinite(dd)) return 'dd0-5';
  for (const b of DD_BANDS) if (b.test(dd)) return b.key;
  return 'dd>25';
}
export function trendBand(shareTrend) {
  if (shareTrend == null || !Number.isFinite(shareTrend)) return 'na';
  if (shareTrend > TREND_DEADBAND) return 'up';
  if (shareTrend < -TREND_DEADBAND) return 'down';
  return 'flat';
}
/** Bucket key from the three grid coordinates. ratio/peakRatio in ratio space. */
export function bucketKey({ ratio, peakRatio: peak, shareTrend }) {
  const pk = peak > 0 ? peak : 1;
  const dd = ratio != null && ratio > 0 ? ratio / pk - 1 : null;
  return `${peakBand(pk)}|${drawdownBand(dd)}|${trendBand(shareTrend)}`;
}

/** Buy-share level + trends over a sample series [{ts, buys, sells, tx}],
 *  mirroring exits.js exactly: samples inside the last 90s, first vs last;
 *  share = buys / tx; missing data = null (unknown = neutral). */
export function flowTrend(samples, now, windowMs = 90000) {
  const fh = (samples || []).filter(s => s && now - s.ts <= windowMs && now - s.ts >= 0);
  const share = s => (s && s.tx > 0 && s.buys != null) ? s.buys / s.tx : null;
  const shareNow = fh.length ? share(fh[fh.length - 1]) : null;
  let shareTrend = null, txTrend = null;
  if (fh.length >= 2) {
    const s0 = share(fh[0]), s1 = share(fh[fh.length - 1]);
    if (s0 != null && s1 != null) shareTrend = s1 - s0;
    const t0 = fh[0].tx, t1 = fh[fh.length - 1].tx;
    if (t0 > 0 && t1 != null) txTrend = t1 / t0;
  }
  return { shareNow, shareTrend, txTrend };
}

// ------------------------------------------------------------ evidence table
/**
 * Build the evidence table from journal history. Pure.
 *   ticks:  [{ id, ts, valueSol, ratio, peak, buysM5, sellsM5 }] (ticks.jsonl)
 *   trades: journal trade records (type 'sell' | 'close' carry what we need)
 * Returns Map bucketKey -> { n, sum } of payoffDiff per unit of mark.
 *
 * A position contributes only when its ladder path is fully reconstructible:
 * it has a close record AND >= 1 journaled sell AND (when the close carries
 * an exitSol) the sells reconcile with it — manual closes journal no sells
 * and are excluded BY CONSTRUCTION: their exit was the human's, not the
 * ladder's, so their truncated paths say nothing about holding under the
 * ladder. A tick contributes only while something was still held (the
 * sells after it returned > 0).
 */
export function buildEvidence({ ticks = [], trades = [], txFeeSol = 0 } = {}) {
  const fee = txFeeSol || 0;
  const closes = new Map();
  const sellsById = new Map();
  for (const t of trades || []) {
    if (!t || !t.id) continue;
    if (t.type === 'close') closes.set(t.id, t);
    else if (t.type === 'sell') { (sellsById.get(t.id) || sellsById.set(t.id, []).get(t.id)).push(t); }
  }
  const usable = new Map(); // id -> { closeTs, sells sorted asc }
  for (const [id, close] of closes) {
    const sells = (sellsById.get(id) || []).filter(s => s.solOut != null).sort((a, b) => a.ts - b.ts);
    if (!sells.length) continue;
    if (close.exitSol != null) {
      const sum = sells.reduce((a, s) => a + s.solOut, 0);
      if (Math.abs(sum - close.exitSol) > Math.max(0.02 * Math.abs(close.exitSol), 1e-6)) continue; // books don't reconcile — don't learn from it
    }
    usable.set(id, { closeTs: close.ts || Infinity, sells });
  }
  const byPos = new Map(); // id -> ticks sorted asc
  for (const tk of ticks || []) {
    if (!tk || !tk.id || !(tk.valueSol > 0) || !usable.has(tk.id)) continue;
    if (tk.ts >= usable.get(tk.id).closeTs) continue;
    (byPos.get(tk.id) || byPos.set(tk.id, []).get(tk.id)).push(tk);
  }
  const table = new Map();
  for (const [id, series] of byPos) {
    series.sort((a, b) => a.ts - b.ts);
    const { sells } = usable.get(id);
    // suffix sums over sells: proceeds + count strictly after any timestamp
    for (let i = 0; i < series.length; i++) {
      const tk = series[i];
      let r = 0, k = 0;
      for (const s of sells) if (s.ts > tk.ts) { r += s.solOut; k++; }
      if (!(r > 0)) continue; // nothing was still held after this tick
      const holdNet = r - fee * k;
      const shadowNet = tk.valueSol - fee;
      const diff = (holdNet - shadowNet) / tk.valueSol;
      // buy-share trend over THIS position's own tick series, 90s window —
      // the same construction the live side applies to flowHist.
      const win = [];
      for (let j = i; j >= 0 && tk.ts - series[j].ts <= 90000; j--) {
        const s = series[j];
        win.unshift({ ts: s.ts, buys: s.buysM5 ?? null, sells: s.sellsM5 ?? null, tx: (s.buysM5 != null || s.sellsM5 != null) ? (s.buysM5 || 0) + (s.sellsM5 || 0) : null });
      }
      const { shareTrend } = flowTrend(win, tk.ts);
      const key = bucketKey({ ratio: tk.ratio, peakRatio: tk.peak, shareTrend });
      const b = table.get(key) || { n: 0, sum: 0 };
      b.n++; b.sum += diff;
      table.set(key, b);
    }
  }
  return table;
}

/** Smoothed bucket EV: the prior pulls toward 0 (no opinion) — a bucket
 *  must EARN a negative verdict against PRIOR_K phantom flat samples. */
export function evOf(bucket, priorK = 10) {
  if (!bucket || !(bucket.n > 0)) return null;
  return bucket.sum / (bucket.n + priorK);
}
/** The whole decision rule: enough evidence AND holding paid worse than exiting. */
export function shouldFire(bucket, { minN = 8, priorK = 10 } = {}) {
  if (!bucket || bucket.n < minN) return false;
  const ev = evOf(bucket, priorK);
  return ev != null && ev < 0;
}

// ------------------------------------------------------------ pairing math
/**
 * Pair one fire with its position's actual close. Pure.
 *   fire:  { remainderSol, realizedSolAtFire, feesSolAtFire }
 *   close: { exitSolTotal (resolved by the caller — close.exitSol, or
 *            pnlSol + entrySol + feesSol when the record carries no exitSol),
 *            feesSol }
 * Returns { shadowNet, holdNet, deltaSol, shadowWin } or null when the
 * close's total proceeds can't be resolved (never invent a number).
 */
export function pairDelta({ fire, close, txFeeSol = 0 }) {
  if (!fire || !close || close.exitSolTotal == null || !(fire.remainderSol > 0)) return null;
  const shadowNet = fire.remainderSol - (txFeeSol || 0);
  const holdNet = (close.exitSolTotal - (fire.realizedSolAtFire || 0)) - ((close.feesSol || 0) - (fire.feesSolAtFire || 0));
  const deltaSol = shadowNet - holdNet;
  return { shadowNet, holdNet, deltaSol, shadowWin: deltaSol > 0 };
}

// ------------------------------------------------------------ the judge
const TICKS_TAIL_BYTES = 16 * 1024 * 1024; // evidence refit reads the tail of ticks.jsonl — bounded, like every other lab's file fold

function readTicksTail(file, maxBytes = TICKS_TAIL_BYTES) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      let text = buf.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
      return text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } finally { fs.closeSync(fd); }
  } catch { return []; }
}

export class ShadowSeller {
  constructor({ cfg, journal = null, now = Date.now, log = () => {}, postExitOf = null } = {}) {
    this.cfg = cfg || {};
    this.journal = journal;
    this.now = now;
    this.log = log;
    this.postExitOf = postExitOf;
    this.table = new Map();
    this.lastFitTs = 0;
    this.firedIds = new Set();     // every position ever fired on (fire-once survives restarts via the journal tail)
    this.openFires = new Map();    // id -> fire record awaiting its close
    this.peaks = new Map();        // id -> { peak, ts|null } module-side peak clock (positions don't stamp when their peak was set)
    if (this.journal && Array.isArray(this.journal.shadowSells)) {
      const paired = new Set(this.journal.shadowSells.filter(r => r && r.kind === 'paired').map(r => r.id));
      for (const r of this.journal.shadowSells) {
        if (!r || r.kind !== 'fire') continue;
        this.firedIds.add(r.id);
        if (!paired.has(r.id)) this.openFires.set(r.id, r);
      }
    }
    if (this.enabled) this.refit();
  }

  get enabled() { return !!this.cfg.shadowSeller; }
  get minN() { return this.cfg.shadowSellerMinN ?? 8; }
  get priorK() { return this.cfg.shadowSellerPriorK ?? 10; }
  get refitMs() { return (this.cfg.shadowSellerRefitMin ?? 15) * 60000; }

  /** Refit the evidence table from the journal (boot + periodic). Fail-silent:
   *  a failed refit keeps the previous table rather than disturbing anything. */
  refit() {
    try {
      if (!this.journal) return;
      const ticksFile = (this.journal.f && this.journal.f.ticks) || path.join(this.cfg.dataDir || '.', 'ticks.jsonl');
      const ticks = readTicksTail(ticksFile);
      this.table = buildEvidence({ ticks, trades: this.journal.trades || [], txFeeSol: this.cfg.txFeeSol || 0 });
      this.lastFitTs = this.now();
    } catch { /* keep the old table */ }
  }

  /** The full state snapshot at one position check — everything the check
   *  already has at hand; genuinely unavailable fields are null, never invented. */
  snapshot(pos, { valueSol, view = {}, n }) {
    const basis = pos.entrySol * pos.remainingFrac;
    const ratio = basis > 0 ? valueSol / basis : null;
    const peakRatio = Math.max(pos.peakRatio || 1, ratio || 0);
    // peak clock: positions don't stamp when the peak was set, so the judge
    // keeps its own — a peak already in place when first observed reads null
    // (unknown), not a fabricated age.
    let pk = this.peaks.get(pos.id);
    if (!pk) { pk = { peak: peakRatio, ts: (ratio != null && peakRatio > ratio + 1e-9) ? null : n }; this.peaks.set(pos.id, pk); }
    else if (peakRatio > pk.peak + 1e-9) { pk.peak = peakRatio; pk.ts = n; }
    const { shareNow, shareTrend, txTrend } = flowTrend(pos.flowHist || [], n);
    return {
      // the bucket is computed from the RAW values, exactly as the evidence
      // side buckets historical ticks — rounding is for the record only.
      bucket: ratio != null ? bucketKey({ ratio, peakRatio, shareTrend }) : null,
      ratio: ratio != null ? round(ratio, 4) : null,
      peakRatio: round(peakRatio, 4),
      drawdown: ratio != null && peakRatio > 0 ? round(ratio / peakRatio - 1, 4) : null,
      heldSec: pos.entryTs ? Math.round((n - pos.entryTs) / 1000) : null,
      secSincePeak: pk.ts != null ? Math.round((n - pk.ts) / 1000) : null,
      tp1Done: !!pos.tp1Done, tp2Done: !!pos.tp2Done,
      shareNow: shareNow != null ? round(shareNow, 4) : null,
      shareTrend: shareTrend != null ? round(shareTrend, 4) : null,
      txTrend: txTrend != null ? round(txTrend, 4) : null,
      buysM5: view.buysM5 ?? null, sellsM5: view.sellsM5 ?? null,
      mc: view.mc ?? null, liqUsd: view.liq ?? null,
      setup: pos.setup || null, entrySol: pos.entrySol ?? null,
      remainingFrac: pos.remainingFrac ?? null, remainderSol: round(valueSol, 6),
    };
  }

  /**
   * Judge one position check (called from Bot.managePosition beside the
   * ratchet shadow judge, same mark). Returns the fire record when the
   * judge would first sell this position, else null. NEVER trades.
   */
  observe(pos, { valueSol, view = {}, n }) {
    if (!this.enabled || !pos || !(valueSol > 0)) return null;
    try {
      if (n - this.lastFitTs > this.refitMs) this.refit();
      const snap = this.snapshot(pos, { valueSol, view, n });
      if (this.firedIds.has(pos.id)) return null; // at most one would-fire per position: the first
      if (snap.ratio == null || !snap.bucket) return null;
      const key = snap.bucket;
      const bucket = this.table.get(key);
      if (!shouldFire(bucket, { minN: this.minN, priorK: this.priorK })) return null;
      const rec = {
        kind: 'fire', ts: n, id: pos.id, mint: pos.mint, symbol: pos.symbol || null, setup: pos.setup || null,
        bucket: key, evidenceN: bucket.n, evidenceEv: round(evOf(bucket, this.priorK), 4),
        ratio: snap.ratio, peakRatio: snap.peakRatio,
        remainderFrac: pos.remainingFrac ?? null, remainderSol: snap.remainderSol,
        realizedSolAtFire: round(pos.realizedSol || 0, 6), feesSolAtFire: round(pos.feesSol || 0, 6),
        snapshot: snap,
      };
      this.firedIds.add(pos.id);
      this.openFires.set(pos.id, rec);
      if (this.journal) this.journal.shadowSell(rec);
      this.log(`[shadow-seller] ${pos.symbol}: WOULD SELL — bucket ${key} (n=${bucket.n}, EV ${rec.evidenceEv}) at ratio ${snap.ratio} off peak ${snap.peakRatio} (record only)`);
      return rec;
    } catch { return null; } // observer only — never disturb the position loop
  }

  /** Pair a fire with the position's close (called from Bot.ensureClose —
   *  the funnel every close passes through exactly once). */
  noteClose(pos, full) {
    if (!this.enabled || !pos) return null;
    this.peaks.delete(pos.id);
    const fire = this.openFires.get(pos.id);
    if (!fire) return null;
    this.openFires.delete(pos.id);
    try {
      const exitSolTotal = full.exitSol != null ? full.exitSol
        : (full.pnlSol != null && full.entrySol != null ? full.pnlSol + full.entrySol + (full.feesSol || 0) : null);
      const d = pairDelta({ fire, close: { exitSolTotal, feesSol: full.feesSol }, txFeeSol: this.cfg.txFeeSol || 0 });
      const rec = {
        kind: 'paired', ts: full.ts || this.now(), id: pos.id, mint: pos.mint, symbol: pos.symbol || null, setup: pos.setup || null,
        fireTs: fire.ts, bucket: fire.bucket, evidenceN: fire.evidenceN, evidenceEv: fire.evidenceEv,
        ratioAtFire: fire.ratio, peakRatioAtFire: fire.peakRatio, remainderSol: fire.remainderSol,
        exitReason: full.reason || null, heldMin: full.heldMin ?? null,
        paired: !!d,
        shadowNet: d ? round(d.shadowNet, 6) : null, holdNet: d ? round(d.holdNet, 6) : null,
        deltaSol: d ? round(d.deltaSol, 6) : null, shadowWin: d ? d.shadowWin : null,
      };
      if (this.journal) this.journal.shadowSell(rec);
      return rec;
    } catch { return null; } // observer only — never disturb the close
  }

  card() {
    if (!this.enabled) return { enabled: false };
    return { enabled: true, ...buildShadowSellerCard(this.journal ? this.journal.shadowSells : [], this.postExitOf, this.now()) };
  }
}

/** Read-only /shadowseller payload over the journaled fire/paired records.
 *  Pure — tested directly. Post-exit moves join at read time (the tracker's
 *  5-minute window finalizes after the close record lands). */
export function buildShadowSellerCard(records, postExitOf, now = Date.now()) {
  const all = (records || []).filter(r => r && (r.kind === 'fire' || r.kind === 'paired'));
  const fires = all.filter(r => r.kind === 'fire');
  const pairedRecs = all.filter(r => r.kind === 'paired' && r.deltaSol != null);
  const deltaSol = pairedRecs.reduce((a, r) => a + r.deltaSol, 0);
  const recent = pairedRecs.slice(-50).reverse().map(r => {
    const pe = postExitOf ? postExitOf(r.id) : null;
    return { ...r, postExitPeakPct: pe ? (pe.peakMovePct ?? null) : null, postExitLastPct: pe ? (pe.lastMovePct ?? null) : null };
  });
  return {
    generatedTs: now,
    totals: {
      fires: fires.length,
      paired: pairedRecs.length,
      shadowWins: pairedRecs.filter(r => r.shadowWin).length,
      deltaSol: round(deltaSol, 6),
    },
    recent,
    ready: pairedRecs.length >= 30,
  };
}
