// postExit.js — what happens AFTER an exit: keep sampling the price for 5 more minutes
// and log the outcome (did it rip without us? did it die — good exit?). Pure sidecar:
// fed from views the poll loop already fetched, never trades, never blocks, and every
// failure is swallowed — it can observe the bot, never disturb it.
import fs from 'node:fs';
import path from 'node:path';

export const POST_EXIT_WINDOW_MS = 5 * 60 * 1000;
const SAMPLE_EVERY_MS = 5000;
const KEEP_DONE = 200;

export function summarizePostExit(anchorPrice, samples) {
  if (!(anchorPrice > 0) || !samples || !samples.length) {
    return { samples: 0, lastMovePct: null, peakMovePct: null, troughMovePct: null };
  }
  const moves = samples.map(s => (s.price / anchorPrice - 1) * 100);
  return {
    samples: samples.length,
    lastMovePct: +moves[moves.length - 1].toFixed(1),
    peakMovePct: +Math.max(...moves).toFixed(1),
    troughMovePct: +Math.min(...moves).toFixed(1),
  };
}

export class PostExitTracker {
  constructor(dir, now = () => Date.now()) {
    this.file = path.join(dir, 'post_exit.jsonl');
    this.now = now;
    this.pending = new Map(); // position id -> entry
    this.done = [];
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean).slice(-KEEP_DONE);
      for (const l of lines) { try { this.done.push(JSON.parse(l)); } catch { /* skip bad line */ } }
    } catch { /* no file yet */ }
  }

  /** Register a just-closed position. anchorPrice = USD price at exit when known;
   *  otherwise the first post-exit sample becomes the anchor. */
  watch(e) {
    try {
      if (!e || !e.id || this.pending.has(e.id)) return;
      this.pending.set(e.id, {
        id: e.id, mint: e.mint, symbol: e.symbol, setup: e.setup || null,
        exitTs: e.exitTs || this.now(), reason: e.reason || null,
        manual: !!e.manual, pnlSol: e.pnlSol ?? null,
        exitPriceUsd: e.exitPriceUsd > 0 ? e.exitPriceUsd : null,
        anchorPrice: e.exitPriceUsd > 0 ? e.exitPriceUsd : null,
        samples: [],
      });
    } catch { /* observer must never throw into the trading path */ }
  }

  sample(mint, price, ts) {
    if (!(price > 0)) return;
    for (const e of this.pending.values()) {
      if (e.mint !== mint) continue;
      if (!e.anchorPrice) e.anchorPrice = price;
      const last = e.samples[e.samples.length - 1];
      if (!last || ts - last.ts >= SAMPLE_EVERY_MS) e.samples.push({ ts, price });
    }
  }

  /** Called from the poll loop with a sync price lookup (mint -> USD price | null). */
  tick(priceOf, nowTs) {
    try {
      for (const e of [...this.pending.values()]) {
        let p = null;
        try { p = priceOf(e.mint); } catch { /* ignore */ }
        if (p > 0) this.sample(e.mint, p, nowTs);
        if (nowTs - e.exitTs >= POST_EXIT_WINDOW_MS) this.finalize(e);
      }
    } catch { /* never disturb the poll loop */ }
  }

  finalize(e) {
    this.pending.delete(e.id);
    const s = summarizePostExit(e.anchorPrice, e.samples);
    const rec = {
      id: e.id, mint: e.mint, symbol: e.symbol, setup: e.setup,
      exitTs: e.exitTs, finalTs: this.now(),
      exitPriceUsd: e.exitPriceUsd, anchorPrice: e.anchorPrice,
      reason: e.reason, manual: e.manual, pnlSol: e.pnlSol, ...s,
    };
    this.done.push(rec);
    if (this.done.length > KEEP_DONE) this.done.shift();
    try { fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); } catch { /* best effort */ }
    return rec;
  }

  recent(n = 50) {
    return {
      pending: [...this.pending.values()].map(e => ({
        id: e.id, mint: e.mint, symbol: e.symbol, exitTs: e.exitTs, samples: e.samples.length,
      })),
      done: this.done.slice(-n).reverse(),
    };
  }
}
