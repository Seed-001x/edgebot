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

/**
 * Rolling per-mint buffer of streamed trades for the shadow judge. Retention is
 * deliberately longer than any sane judgement window; the window itself is
 * applied at read time. Trades arrive in receipt order (the feed stamps ts).
 */
export class ShadowFlow {
  constructor({ retentionSec = 150, maxTrades = 2000 } = {}) {
    this.retentionMs = retentionSec * 1000;
    this.maxTrades = maxTrades;
    this.byMint = new Map(); // mint -> [{ ts, buy, sol }]
  }

  /** Buffer one streamed trade ({ ts, side: 'buy'|'sell', sol }). Bad prints are ignored. */
  note(mint, trade) {
    if (!mint || !trade || !(trade.sol > 0)) return;
    const ts = trade.ts || Date.now();
    let buf = this.byMint.get(mint);
    if (!buf) { buf = []; this.byMint.set(mint, buf); }
    buf.push({ ts, buy: trade.side === 'buy', sol: trade.sol });
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
    const buf = this.byMint.get(mint);
    if (!buf || !buf.length) return null;
    const cutoff = now - windowSec * 1000;
    let buySol = 0, sellSol = 0, trades = 0;
    for (const t of buf) {
      if (t.ts < cutoff || t.ts > now) continue;
      trades++;
      if (t.buy) buySol += t.sol; else sellSol += t.sol;
    }
    if (!trades) return null;
    const tot = buySol + sellSol;
    return { buySol, sellSol, sellShare: tot > 0 ? sellSol / tot : 0, trades };
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
