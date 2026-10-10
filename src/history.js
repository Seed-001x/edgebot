// history.js — time-based per-mint price history (NOT count-based).
// Keeps HISTORY_MS of samples regardless of poll cadence, so detectors behave the same at 5s or 30s polling.

const HISTORY_MS = 90 * 60 * 1000;
const MAX_SAMPLES = 900;

export class History {
  constructor() { this.m = new Map(); }

  record(view, ts) {
    if (!view || !(view.price > 0)) return;
    let a = this.m.get(view.address);
    if (!a) { a = []; this.m.set(view.address, a); }
    const last = a[a.length - 1];
    const s = { ts, price: view.price, mc: view.mc, volM5: view.volM5, volH1: view.volH1, buysM5: view.buysM5, sellsM5: view.sellsM5, liq: view.liq };
    if (last && ts - last.ts < 2000) a[a.length - 1] = s; else a.push(s);
    while (a.length && ts - a[0].ts > HISTORY_MS) a.shift();
    while (a.length > MAX_SAMPLES) a.shift();
  }

  get(mint) { return this.m.get(mint) || []; }

  /** Samples within the last windowMs. */
  window(mint, windowMs, now) {
    const a = this.get(mint);
    let i = 0;
    while (i < a.length && now - a[i].ts > windowMs) i++;
    return a.slice(i);
  }

  prune(now, keep = new Set()) {
    for (const [k, a] of this.m) {
      if (keep.has(k)) continue;
      const last = a[a.length - 1];
      if (!last || now - last.ts > 30 * 60 * 1000) this.m.delete(k);
    }
  }
}
