// ratchetShadow.js — SHADOW (record-only) flow judge for the break-even ratchet
// (user 2026-10-14). The live ratchet (exits.js §4c) judges the realizable move on
// 4-second polls: it arms at beArmPct and sells when the move falls back to
// beTriggerPct. Its first live firing (MINDPAD) filled at −9.3% because the coin
// crashed clean through the trigger line between two polls — the price the
// ratchet saw was already the aftermath. The user's idea: judge the ratchet on
// the live trade STREAM instead — when an armed position's flow flips to heavy
// selling while the price comes off its high, the dump's own prints say "sell"
// seconds before the quote finishes repricing.
//
// This module is the OBSERVER version, approved as record-only: it can never
// sell. bot.js feeds it streamed trades for HELD mints only, asks it on every
// position check whether the flow test WOULD have fired, and journals the
// would-fire (plus a completion record at close) to ratchet_shadow.jsonl so the
// two triggers can be compared offline before anyone wires it live. Fail-silent
// throughout: no stream flow for a mint (e.g. a venue the feed doesn't carry)
// simply means no opinion.
//
// STREAM JUDGE v2 (user 2026-10-15, still record-only): the tick judge above
// only ever asks its question when a 4s quote poll runs, so its "stream" data
// is judged at poll cadence — the very lag it was built to measure. bot.js now
// ALSO evaluates the same pure test on the trade path itself (throttled per
// mint, kind 'would-fire-stream'): identical arm/fire rule, but the price
// basis is the stream's own VWAP (vwap() below) measured from the position's
// actual entry fill, with the stream keeping its OWN peak for both the arm
// and the decline legs — a stream +5% is not the quote's +5% (the quote is
// born ~3% under water from the round trip), so the two judges' records are
// cross-tagged (jupArmed / streamArmed / both fire timestamps) and lead time
// is only ever read off positions where both armed. Fires are quality-probed
// (the quote mark at +30s/+60s after a stream fire) so an early fire on a
// fakeout reads as one. The judge also runs over the trade-grade shadow book
// (source 'shadow', counted separately) to grow the sample beyond held
// positions, and every completion record carries its stream coverage so a
// mint the feed never printed for can never silently drop out of the
// comparison. None of this touches the live ratchet or any exit.

/**
 * Rolling per-mint buffer of streamed trades for the shadow judge. Retention is
 * deliberately longer than any sane judgement window; the window itself is
 * applied at read time. Trades arrive in receipt order (the feed stamps ts).
 */
export class ShadowFlow {
  constructor({ retentionSec = 150, maxTrades = 2000 } = {}) {
    this.retentionMs = retentionSec * 1000;
    this.maxTrades = maxTrades;
    this.byMint = new Map(); // mint -> [{ ts, buy, sol, tokens }] (tokens rides for the v2 VWAP basis; older readers ignore it)
  }

  /** Buffer one streamed trade ({ ts, side: 'buy'|'sell', sol, tokens }). Bad prints are ignored. */
  note(mint, trade) {
    if (!mint || !trade || !(trade.sol > 0)) return;
    const ts = trade.ts || Date.now();
    let buf = this.byMint.get(mint);
    if (!buf) { buf = []; this.byMint.set(mint, buf); }
    buf.push({ ts, buy: trade.side === 'buy', sol: trade.sol, tokens: trade.tokens > 0 ? trade.tokens : null });
    const cutoff = ts - this.retentionMs;
    while (buf.length && buf[0].ts < cutoff) buf.shift();
    if (buf.length > this.maxTrades) buf.splice(0, buf.length - this.maxTrades);
  }

  /**
   * Aggregate the last windowSec of flow for a mint: { buySol, sellSol,
   * sellShare, trades } — or null when the window holds no trades at all
   * (no stream coverage / quiet coin: the judge has no opinion).
   */
  window(mint, now, windowSec) {
    const r = this.windowRange(mint, now - windowSec * 1000, now);
    if (!r) return null;
    const tot = r.buySol + r.sellSol;
    return { buySol: r.buySol, sellSol: r.sellSol, sellShare: tot > 0 ? r.sellSol / tot : 0, trades: r.trades };
  }

  /**
   * D1 (record-only): raw buy/sell counts + SOL volume over an arbitrary
   * [fromTs, toTs] range — the manual-exit snapshot's 30s/60s/prior-minute
   * flow windows. Returns null when the range holds no streamed trades.
   */
  windowRange(mint, fromTs, toTs) {
    const buf = this.byMint.get(mint);
    if (!buf || !buf.length) return null;
    let buys = 0, sells = 0, buySol = 0, sellSol = 0;
    for (const t of buf) {
      if (t.ts < fromTs || t.ts > toTs) continue;
      if (t.buy) { buys++; buySol += t.sol; } else { sells++; sellSol += t.sol; }
    }
    if (!buys && !sells) return null;
    return { buys, sells, buySol, sellSol, trades: buys + sells };
  }

  /**
   * Stream-judge price basis (v2): SOL-per-token VWAP over the last windowSec
   * — Σsol / Σtokens across the prints that carry a token amount. Returns
   * { price, prints, sol } or null when the window holds no priced prints.
   * Volume weighting is the dust defense: a 0.001-SOL print at a crazy price
   * moves a last-print or max-print reading by hundreds of percent and moves
   * this average by ~nothing, so it can neither set a peak nor fake a fade.
   * Callers require prints >= 2 before treating the reading as an opinion.
   */
  vwap(mint, now, windowSec) {
    const buf = this.byMint.get(mint);
    if (!buf || !buf.length) return null;
    const from = now - windowSec * 1000;
    let sol = 0, tokens = 0, prints = 0;
    for (const t of buf) {
      if (t.ts < from || t.ts > now) continue;
      if (!(t.tokens > 0)) continue;
      sol += t.sol; tokens += t.tokens; prints++;
    }
    if (!prints || !(tokens > 0)) return null;
    return { price: sol / tokens, prints, sol };
  }

  drop(mint) { this.byMint.delete(mint); }
}

/**
 * Armed = the same definition the live ratchet (§4c) uses: the ratchet is on
 * (beArmPct > 0), the position is pre-TP1, and its own recorded peak realizable
 * move has reached the arm line. Anything else is not the ratchet's business.
 */
export function ratchetArmed(peakMove, tp1Done, cfg) {
  return !!cfg && cfg.beArmPct > 0 && !tp1Done && peakMove != null && peakMove >= 1 + cfg.beArmPct;
}

/**
 * The would-fire test. ALL legs must hold:
 *   - armed (above)
 *   - declining: the current realizable move is below the position's peak move
 *     (the price has come off its high — stream prints while it is still making
 *     highs are absorption, not an exit wave)
 *   - the last ratchetFlowWindowSec of streamed flow is heavy selling:
 *     sellShare >= ratchetFlowSellShare AND sellSol >= ratchetFlowMinSellSol
 *     (one whale taking profit must not trip it — share AND size)
 * Returns the flow snapshot on a fire, null otherwise. Pure; no side effects.
 */
export function ratchetShadowFire({ peakMove, tp1Done, move, flow, cfg }) {
  if (!ratchetArmed(peakMove, tp1Done, cfg)) return null;
  if (!(move < peakMove)) return null;
  if (!flow) return null;
  if (!(flow.sellSol >= cfg.ratchetFlowMinSellSol)) return null;
  if (!(flow.sellShare >= cfg.ratchetFlowSellShare)) return null;
  return { sellShare: flow.sellShare, sellSol: flow.sellSol, buySol: flow.buySol };
}
