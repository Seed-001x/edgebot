// exits.js — pure exit logic. Judged on REALIZABLE value (Jupiter sell quote), not screen price.
//
// pos  = { entrySol, remainingFrac, peakRatio, peakMove, tp1Done, entryTs, entryRoundTrip? }
// mark = { valueSol, liqUsd, buysM5, sellsM5, solUsd }
// returns { fraction (0..1 of CURRENT holding; 0 = hold), reason, newPeak, newPeakMove, ratio }
//
// ratio = valueSol / (entrySol * remainingFrac): value of what's left vs its share of cost basis.
// move  = ratio / entryRoundTrip: the PRICE move since entry. Right after a buy the sell quote is already
//         below cost by the round-trip (fees + slippage), so a flat coin reads e.g. 0.93 on `ratio` but 1.00 on `move`.
//         The dip stop and the stall exit use `move`, so they fire on what the price did, not on sunk fees.

export function evaluateExit(pos, mark, cfg, now) {
  const basis = pos.entrySol * pos.remainingFrac;
  const ratio = basis > 0 ? mark.valueSol / basis : 0;
  const peakRatio = Math.max(pos.peakRatio || 1, ratio);
  const heldMin = (now - pos.entryTs) / 60000;
  const base = pos.entryRoundTrip > 0 ? pos.entryRoundTrip : 1;
  const move = ratio / base;

  // gain = what you'd actually pocket on the remaining position: the sell quote (already net of pool fees,
  // slippage and price impact) minus SOL network fees for the buy + up to two sells. Profit-side exits use this,
  // so a take-profit is always a real profit, never a "price is up but fees ate it" exit.
  const feeFrac = basis > 0 ? (3 * (cfg.txFeeSol || 0)) / basis : 0;
  const gain = ratio - 1 - feeFrac;
  const peakGain = peakRatio - 1 - feeFrac;

  // best price move seen so far (peak of `move`, NOT of ratio: peakRatio is floored at 1 while the
  // first realizable quote already sits at the round-trip ~0.95, so ratio/base would fake a breakout).
  // Positions opened before peakMove existed seed from their stored peakRatio — a one-off migration
  // approximation; every position opened since carries the exact peakMove from birth.
  const peakMove = Math.max(pos.peakMove != null ? pos.peakMove : (pos.peakRatio || 1) / base, move);
  const out = (fraction, reason) => ({ fraction, reason, newPeak: peakRatio, newPeakMove: peakMove, ratio, stallSince: null });

  // 1. liquidity death: the pool can no longer absorb what we hold
  const valueUsd = mark.valueSol * (mark.solUsd || 150);
  if (mark.liqUsd != null && (mark.liqUsd < 2000 || mark.liqUsd < valueUsd * 2)) return out(1, `liquidity death ($${Math.round(mark.liqUsd)} liq vs $${Math.round(valueUsd)} position)`);

  // 2a. dip stop: price fell dipStopPct below entry — sell, no exceptions
  if (cfg.dipStopPct > 0 && move <= 1 - cfg.dipStopPct) return out(1, `dip stop (price ${((move - 1) * 100).toFixed(1)}% from entry)`);

  // 2. hard stop on realizable value — no exceptions
  if (ratio <= 1 - cfg.stopLoss) return out(1, `stop-loss (${((ratio - 1) * 100).toFixed(0)}%)`);

  // 3. first take-profit on the jump: bank part, let the rest run (skipped if user disabled TP for this position).
  //    +25% means +25% in your pocket after slippage and SOL fees, not +25% on the chart.
  if (!pos.tp1Done && !pos.noTp && cfg.tp1Frac > 0 && gain >= cfg.tp1Pct) return { ...out(cfg.tp1Frac, `TP1 +${(cfg.tp1Pct * 100).toFixed(0)}%`), tp1: true };

  // 3b. post-TP1 trail: after banking the TP1 slice, trail the rest tpTrailPct below its peak with a hard floor
  //     at entry — sell everything if it gives back the trail or fades back to cost.
  if (pos.tp1Done && (ratio <= peakRatio * (1 - cfg.tpTrailPct) || ratio <= 1)) return out(1, `post-TP1 trail (peak ${(peakRatio).toFixed(2)}x, now ${((ratio - 1) * 100).toFixed(1)}%)`);

  // 4. trailing stop once armed
  if (peakRatio >= 1 + cfg.trailArm && ratio <= peakRatio * (1 - cfg.trailPct)) return out(1, `trailing stop (${(cfg.trailPct * 100).toFixed(0)}% off peak ${(peakRatio).toFixed(2)}x)`);

  // 4a. profit lock: once up lockArm+ after costs, don't let it round-trip — sell if it gives back (1 - lockKeep) of its
  //     best real gain. Scales with the move: best +40% → sells at +20%; best +200% → sells at +100% (lockKeep 0.5).
  if (cfg.lockKeep > 0 && peakGain >= cfg.lockArm && gain <= peakGain * cfg.lockKeep) return out(1, `profit lock (best +${(peakGain * 100).toFixed(0)}%, now +${(gain * 100).toFixed(0)}% after fees)`);

  // 4b. entry stall (user 2026-10-13): the clock starts AT ENTRY and never pauses. If the price never
  //     broke out of the entry range — best move stayed under entry + stallBandPct — within stallSec,
  //     it isn't running: sell. Above or below entry inside the range makes no difference, and a coin
  //     that did break out inside the window is exempt for the rest of the trade however it fades.
  if (cfg.stallSec > 0 && heldMin * 60 >= cfg.stallSec && peakMove < 1 + cfg.stallBandPct) return out(1, `stall (no breakout in ${cfg.stallSec}s, best ${((peakMove - 1) * 100).toFixed(1)}%)`);

  // 5. momentum failure: underwater, 10 min in, essentially no buyers (only sell when truly dead)
  if (heldMin >= 10 && ratio < 1 && mark.buysM5 != null && mark.buysM5 <= 1 && mark.sellsM5 > mark.buysM5 * 3) return out(1, 'momentum failure (no buyers)');

  // 5b. volume decay: volume dried up 70%+ from entry and price isn't pushing up — no fuel left
  if (pos.entryVolH1 > 0 && mark.volH1 != null && heldMin >= 5) {
    const volRatio = mark.volH1 / pos.entryVolH1;
    if (volRatio < 0.3 && ratio < 1.05) return out(1, `volume decay (vol ${(volRatio * 100).toFixed(0)}% of entry, price ${((ratio - 1) * 100).toFixed(1)}%)`);
  }

  // 6. time stop: didn't work fast enough
  if (heldMin >= cfg.timeStopMin && ratio < 1 + cfg.timeStopMinGain) return out(1, `time stop (${Math.round(heldMin)}m, ${((ratio - 1) * 100).toFixed(0)}%)`);

  // 7. absolute max hold
  if (heldMin >= cfg.maxHoldMin) return out(1, `max hold ${cfg.maxHoldMin}m`);

  return out(0, null);
}
