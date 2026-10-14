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

  // Adaptive-TP1 state + strength snapshot (user 2026-10-13): "strong" = the run still looks
  // supported RIGHT NOW — price at/near its high, buyers holding their share of the 5m flow, and
  // the trade count not collapsing — trended over the position's OWN recorded marks (bot.js appends
  // {ts, buys, sells, tx} to pos.flowHist at every position check, the freshest series available).
  // Missing data never counts against strength (null = unknown = neutral).
  let tp1Arm = pos.tp1Arm || null;
  const txNow = (mark.buysM5 != null || mark.sellsM5 != null) ? (mark.buysM5 || 0) + (mark.sellsM5 || 0) : null;
  const shareNow = txNow > 0 && mark.buysM5 != null ? mark.buysM5 / txNow : null;
  let shareTrend = null, txTrend = null;
  const fh = (pos.flowHist || []).filter(s => s && now - s.ts <= 90000 && now - s.ts >= 0);
  if (fh.length >= 2) {
    const f0 = fh[0], f1 = fh[fh.length - 1];
    const sh = s => (s.tx > 0 && s.buys != null) ? s.buys / s.tx : null;
    const s0 = sh(f0), s1 = sh(f1);
    if (s0 != null && s1 != null) shareTrend = s1 - s0;
    if (f0.tx > 0 && f1.tx != null) txTrend = f1.tx / f0.tx;
  }
  const strong = ratio >= peakRatio * 0.98
    && (shareNow == null || shareNow >= (cfg.tp1FlowMin ?? 0.5))
    && (shareTrend == null || shareTrend >= -0.10)
    && (txTrend == null || txTrend >= 0.6);
  // grace-stop state: armed the first tick the realizable value breaches the arm line (section 2b).
  // Recovery above the arm line cancels the arming outright (user 2026-10-13).
  let stopArmedTs = pos.stopArmedTs || null;
  if (ratio > 1 - cfg.stopLoss) stopArmedTs = null;
  // hard-floor confirmation (user 2026-10-13): consecutive checks seen at/below the floor.
  // Any check back above the floor resets the count — a wick that snaps back never fires it.
  const hardBreached = cfg.stopHardPct > 0 && ratio <= 1 - cfg.stopHardPct;
  let floorChecks = hardBreached ? (pos.floorChecks || 0) : 0;
  // how long the breach has persisted: the floor also requires stopHardConfirmSec down there
  // before it fires (user 2026-10-13: 3s — "be sure it's still there"). Any check back above
  // the floor clears the clock together with the count.
  let floorSince = hardBreached ? (pos.floorSince ?? now) : null;
  const out = (fraction, reason) => ({ fraction, reason, newPeak: peakRatio, newPeakMove: peakMove, ratio, stallSince: null, stopArmedTs, floorChecks, floorSince, tp1Arm });

  // 1. liquidity death: the pool can no longer absorb what we hold
  const valueUsd = mark.valueSol * (mark.solUsd || 150);
  if (mark.liqUsd != null && (mark.liqUsd < 2000 || mark.liqUsd < valueUsd * 2)) return out(1, `liquidity death ($${Math.round(mark.liqUsd)} liq vs $${Math.round(valueUsd)} position)`);

  // 2a. dip stop: price fell dipStopPct below entry — sell, no exceptions
  if (cfg.dipStopPct > 0 && move <= 1 - cfg.dipStopPct) return out(1, `dip stop (price ${((move - 1) * 100).toFixed(1)}% from entry)`);

  // 2a2. hard floor on realizable value — but confirmed (user 2026-10-13): one tick under the
  //      floor is a wick until the next check proves the price is still there. Both of today's
  //      floor fires (Udderstep, SAMM) were sub-4s wicks that bounced instantly and then ripped;
  //      the floor sold the bottom of both. Requiring stopHardConfirmChecks consecutive checks
  //      at/below the floor (default 2) lets the snap-back disarm it (floorChecks resets above),
  //      while a real collapse is still there ~4s later and sells. No flow veto once confirmed.
  //      An unconfirmed breach falls through: the grace stop (2b) arms on this same tick and
  //      governs the -10..-20 zone unless the floor confirms on the next check.
  if (hardBreached) {
    floorChecks += 1;
    const checksOk = floorChecks >= (cfg.stopHardConfirmChecks ?? 2);
    const timeOk = now - floorSince >= (cfg.stopHardConfirmSec || 0) * 1000;
    if (checksOk && timeOk) return out(1, `stop-loss (${((ratio - 1) * 100).toFixed(0)}%, hard floor${(cfg.stopHardConfirmSec || 0) > 0 ? `, confirmed ${((now - floorSince) / 1000).toFixed(0)}s under` : ((cfg.stopHardConfirmChecks ?? 2) > 1 ? `, confirmed ${floorChecks} checks` : '')})`);
  }

  // 2b. grace stop (user 2026-10-13): breaching the arm line (cfg.stopLoss) starts a grace window
  //     instead of selling on the tick. When the window ends, the flow decides with an exact test:
  //     sells outweighing buys (sellsM5 > buysM5) or almost no buys left (buysM5 <= 2) — or no flow
  //     data at all — confirms the death and sells. Buyers at least matching sells vetoes the sell
  //     (they're absorbing the dip) and disarms, so a later breach re-arms fresh.
  if (cfg.stopLoss > 0 && ratio <= 1 - cfg.stopLoss) {
    if (stopArmedTs == null) stopArmedTs = now;
    if (now - stopArmedTs >= (cfg.stopGraceSec || 0) * 1000) {
      const flowAlive = cfg.stopFlowVeto > 0 && mark.buysM5 != null && mark.buysM5 > 2 && mark.sellsM5 <= mark.buysM5;
      if (!flowAlive) return out(1, `stop-loss (${((ratio - 1) * 100).toFixed(0)}%, confirmed after ${cfg.stopGraceSec}s grace, flow ${mark.buysM5 ?? '?'}b/${mark.sellsM5 ?? '?'}s)`);
      stopArmedTs = null;
    }
  }

  // 3. TP ladder (user 2026-10-13): sell INTO strength at fixed levels — up-firing exits fill near
  //    their level, while down-firing trails gap 25-55 points through their lines on one-candle
  //    dumps (the recorded exits of all nine recent 2.4-3.1x runners). TP1 is ADAPTIVE (the user's
  //    twist): it arms at tp1Pct and, while the run still looks strong (see `strong` above), the
  //    bank target slides up toward tp1AdaptMax; it fires at the ceiling, on a tp1Giveback rollover
  //    from the peak, or the moment strength fades. Gains are net of fees, as always here.
  if (!pos.tp1Done && !pos.noTp && cfg.tp1Frac > 0) {
    if (tp1Arm == null && gain >= cfg.tp1Pct) tp1Arm = { ts: now, share: shareNow };
    if (tp1Arm != null) {
      let fire = null;
      if (gain >= cfg.tp1AdaptMax) fire = `ceiling +${Math.round(cfg.tp1AdaptMax * 100)}%`;
      else if (peakGain - gain >= cfg.tp1Giveback) fire = 'rollover';
      else if (!strong) fire = 'strength faded';
      if (fire) return { ...out(cfg.tp1Frac, `TP1 +${(gain * 100).toFixed(0)}% (adaptive: ${fire})`), tp1: true, tp1Arm: null };
    }
  }

  // 3b. TP2: the second bank, at tp2Pct — sells tp2Frac of the ORIGINAL position (converted to a
  //     fraction of what remains). Fires on the way up, near the level, before the dump candle.
  if (pos.tp1Done && !pos.tp2Done && !pos.noTp && cfg.tp2Frac > 0 && gain >= cfg.tp2Pct) {
    const frac = Math.min(1, cfg.tp2Frac / Math.max(pos.remainingFrac, 1e-9));
    return { ...out(frac, `TP2 +${(gain * 100).toFixed(0)}%`), tp2: true };
  }

  // 3c. moonbag: the post-TP2 remainder trails bagTrailPct below its peak — no at-entry floor, and
  //     the generic trailing stop / profit lock below skip tp2Done positions: the bag's job is to ride.
  if (pos.tp2Done && ratio <= peakRatio * (1 - cfg.bagTrailPct)) return out(1, `moonbag trail (${Math.round(cfg.bagTrailPct * 100)}% off peak ${peakRatio.toFixed(2)}x, now ${((ratio - 1) * 100).toFixed(1)}%)`);

  // 3d-pre. TP2 rejection (user 2026-10-13): the middle stage climbed to within reach of the TP2
  //     mark (peak net gain >= tp2RejectZone) but never converted; a fade of tp2RejectDrop off
  //     that peak is a rejection, not a pullback — sell the remainder instead of riding the wide
  //     trail down (wizardcat: peaked +80% net, rode the 25% trail out at +34%).
  if (pos.tp1Done && !pos.tp2Done && cfg.tp2RejectZone > 0 && peakGain >= cfg.tp2RejectZone && ratio <= peakRatio * (1 - cfg.tp2RejectDrop)) return out(1, `TP2 rejection (peak +${(peakGain * 100).toFixed(0)}%, now ${((ratio - 1) * 100).toFixed(1)}%)`);

  // 3d. post-TP1 trail (middle stage, pre-TP2): trail the rest tpTrailPct below its peak with a hard
  //     floor at entry — sell everything if it gives back the trail or fades back to cost.
  if (pos.tp1Done && !pos.tp2Done && (ratio <= peakRatio * (1 - cfg.tpTrailPct) || ratio <= 1)) return out(1, `post-TP1 trail (peak ${(peakRatio).toFixed(2)}x, now ${((ratio - 1) * 100).toFixed(1)}%)`);

  // 4. trailing stop once armed (never on the moonbag — it has its own wider trail, 3c)
  if (!pos.tp2Done && peakRatio >= 1 + cfg.trailArm && ratio <= peakRatio * (1 - cfg.trailPct)) return out(1, `trailing stop (${(cfg.trailPct * 100).toFixed(0)}% off peak ${(peakRatio).toFixed(2)}x)`);

  // 4a. profit lock: once up lockArm+ after costs, don't let it round-trip — sell if it gives back (1 - lockKeep) of its
  //     best real gain. Scales with the move: best +40% → sells at +20%; best +200% → sells at +100% (lockKeep 0.5).
  //     Skips the moonbag (post-TP2): the ladder, not the lock, governs the bag.
  if (!pos.tp2Done && cfg.lockKeep > 0 && peakGain >= cfg.lockArm && gain <= peakGain * cfg.lockKeep) return out(1, `profit lock (best +${(peakGain * 100).toFixed(0)}%, now +${(gain * 100).toFixed(0)}% after fees)`);

  // 4b. entry stall (user 2026-10-13, endpoint version): at stallSec from entry, judge where the
  //     price IS, not where it has been — inside the entry range = stalling = sell, however it
  //     got there. The range is asymmetric (user 2026-10-14): −stallBandPct below entry but only
  //     +stallBandUpPct above it — up more than +3% at the deadline is working, not stalled
  //     (UNTXED sold at +2.2% then ripped). A spike that faded back into the range sells; a coin
  //     still outside the range (either direction) is some other rule's problem. Post-TP1
  //     runners are exempt.
  const stallBandUp = cfg.stallBandUpPct ?? cfg.stallBandPct;
  if (cfg.stallSec > 0 && !pos.tp1Done && heldMin * 60 >= cfg.stallSec && move >= 1 - cfg.stallBandPct && move <= 1 + stallBandUp) return out(1, `stall (in entry range at ${cfg.stallSec}s, ${((move - 1) * 100).toFixed(1)}%)`);

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
