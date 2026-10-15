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
  // probation-leash state (user 2026-10-14): the tick the position was first caught inside
  // the entry-stall range at/after the stall deadline (section 4b). Null = not on probation.
  let probationSince = pos.probationSince ?? null;
  // bleed-exit move history (user 2026-10-14): the position's own per-check `move` prints —
  // appended here, persisted by the caller with the rest of the exit state, bounded to the
  // last 40 checks (~160s at the 4s cadence, comfortably past the bleed lookback). The bleed
  // section (4d) judges "still falling" against this series and nothing else.
  const moveHist = [...(pos.moveHist || []), { ts: now, move }].slice(-40);
  // Fail-safe confirmation state (user 2026-10-14, "a fail safe to the fail safe"): per-kind
  // pending triggers for the three fail-safe exits (leash / ratchet / bleed), persisted on
  // the position by the caller alongside probationSince/moveHist. A position carrying NO
  // exitPending field was opened before this layer existed and keeps the instant behavior —
  // the same legacy fail-open the ratchet's arming uses for a missing peakMove. bot.js
  // initializes exitPending: {} at entry, so every position it opens is covered.
  let exitPending = (pos.exitPending && typeof pos.exitPending === 'object') ? { ...pos.exitPending } : null;
  const exitConfirmEvents = [];
  // PROTECT switch (user 2026-10-15, "just the stop loss… no ratchet", "no SL until I
  // say"): a one-time, per-position flag set via POST /protect while the user rides a
  // coin himself. While protected, ONLY the stop-loss family (2a dip stop, 2a2 hard
  // floor, 2b grace stop) and the break-even ratchet (4c) are skipped — the bleed,
  // probation/stall, momentum failure, trailing stop, time stops and the full TP
  // ladder all judge exactly as normal. The flag holds for the LIFE of the position:
  // no timeout, no auto-expiry; it clears only when the position closes or when
  // POST /unprotect clears it (bot.js owns both). The stop's armed state and any
  // ratchet pending are dropped from the returned state below so neither can execute
  // while the flag is set; bleed/leash pendings pass through untouched. Each
  // suppression is reported on the decision as protectedBlock (the first suppressed
  // kind, once per check) for bot.js to count in stats.protect.
  const prot = !!pos.protected;
  let protectedBlock = null;
  const noteBlock = (kind) => { if (prot && !protectedBlock) protectedBlock = kind; };
  if (prot) {
    stopArmedTs = null; floorChecks = 0; floorSince = null;
    if (exitPending != null) delete exitPending.ratchet;
  }
  // TAKEOVER switch (user 2026-10-15, the XZON race: his manual sell collided with
  // the bot's own ratchet sell and the bot's sell found no balance): POST /takeover
  // hands the position to the user ENTIRELY. While pos.takenOver is set, NO exit
  // section below runs — not the TP ladder, not the trails, not the stop family,
  // not bleed/leash/ratchet, not the time stops, not even liquidity death: the bot
  // must never sell any fraction of a coin the user is driving himself. Tracking
  // still runs (ratio/peak/moveHist above are computed and returned, so marks and
  // the true peak stay current for the dashboard and for release), but all ARMING
  // state is dropped from the returned state: pendings cleared silently (no fake
  // cancel events — exitConfirmEvents stays empty), the stop un-armed, probation
  // and the adaptive-TP1 arm cleared. On release (bot.js), judging resumes fresh:
  // the stall/probation clock re-anchors to the release moment (stallBaseTs,
  // section 4b), so no clock that matured during the takeover can fire. Takeover
  // supersedes protect: with both flags set, this return wins and nothing judges.
  const taken = !!pos.takenOver;
  const out = (fraction, reason) => ({ fraction, reason, newPeak: peakRatio, newPeakMove: peakMove, ratio, stallSince: null, stopArmedTs, floorChecks, floorSince, probationSince, tp1Arm, moveHist, exitPending, exitConfirmEvents, protectedBlock });
  if (taken) {
    stopArmedTs = null; floorChecks = 0; floorSince = null; probationSince = null; tp1Arm = null;
    if (exitPending != null) exitPending = {};
    return { ...out(0, null), takenOver: true };
  }
  // failSafe(kind, reason): a fail-safe exit whose FULL condition is true on this check calls
  // this instead of returning its sell directly. EXIT_CONFIRM_SEC = 0 (or a legacy position)
  // → the sell decision, exactly as before the layer. Otherwise the first trigger only ARMS
  // the pending ({kind: now}) and returns null — evaluation continues, so every other exit
  // still judges this check and any sell it produces executes normally; the pending sells on
  // the first check at/after the window with the condition still true (counted 'confirmed').
  const failSafe = (kind, reason) => {
    if (!((cfg.exitConfirmSec || 0) > 0) || exitPending == null) return out(1, reason);
    const since = exitPending[kind];
    if (since == null) { exitPending[kind] = now; return null; }
    if (now - since >= cfg.exitConfirmSec * 1000) {
      delete exitPending[kind];
      exitConfirmEvents.push({ type: 'confirmed', kind });
      return out(1, reason);
    }
    return null;
  };
  // cancelPending(kind): the exit's condition read FALSE on a check inside its window — the
  // breakdown did not hold, so the pending sell is disarmed (counted 'cancelled') and the
  // exit can re-trigger later with a fresh window.
  const cancelPending = (kind) => {
    if (exitPending != null && exitPending[kind] != null) {
      delete exitPending[kind];
      exitConfirmEvents.push({ type: 'cancelled', kind });
    }
  };

  // 1. liquidity death: the pool can no longer absorb what we hold
  const valueUsd = mark.valueSol * (mark.solUsd || 150);
  if (mark.liqUsd != null && (mark.liqUsd < 2000 || mark.liqUsd < valueUsd * 2)) return out(1, `liquidity death ($${Math.round(mark.liqUsd)} liq vs $${Math.round(valueUsd)} position)`);

  // 2a. dip stop: price fell dipStopPct below entry — sell, no exceptions
  //     (PROTECT: skipped while the position is protected — part of the stop-loss family)
  if (cfg.dipStopPct > 0 && move <= 1 - cfg.dipStopPct) {
    if (prot) noteBlock('dip stop');
    else return out(1, `dip stop (price ${((move - 1) * 100).toFixed(1)}% from entry)`);
  }

  // 2a2. hard floor on realizable value — but confirmed (user 2026-10-13): one tick under the
  //      floor is a wick until the next check proves the price is still there. Both of today's
  //      floor fires (Udderstep, SAMM) were sub-4s wicks that bounced instantly and then ripped;
  //      the floor sold the bottom of both. Requiring stopHardConfirmChecks consecutive checks
  //      at/below the floor (default 2) lets the snap-back disarm it (floorChecks resets above),
  //      while a real collapse is still there ~4s later and sells. No flow veto once confirmed.
  //      An unconfirmed breach falls through: the grace stop (2b) arms on this same tick and
  //      governs the -10..-20 zone unless the floor confirms on the next check.
  if (hardBreached) {
    if (prot) noteBlock('stop-loss'); // PROTECT: the hard floor is stop-loss family — skipped, and its counters stay cleared (see the protect block above)
    else {
      floorChecks += 1;
      const checksOk = floorChecks >= (cfg.stopHardConfirmChecks ?? 2);
      const timeOk = now - floorSince >= (cfg.stopHardConfirmSec || 0) * 1000;
      if (checksOk && timeOk) return out(1, `stop-loss (${((ratio - 1) * 100).toFixed(0)}%, hard floor${(cfg.stopHardConfirmSec || 0) > 0 ? `, confirmed ${((now - floorSince) / 1000).toFixed(0)}s under` : ((cfg.stopHardConfirmChecks ?? 2) > 1 ? `, confirmed ${floorChecks} checks` : '')})`);
    }
  }

  // 2b. grace stop (user 2026-10-13): breaching the arm line (cfg.stopLoss) starts a grace window
  //     instead of selling on the tick. When the window ends, the flow decides with an exact test:
  //     sells outweighing buys (sellsM5 > buysM5) or almost no buys left (buysM5 <= 2) — or no flow
  //     data at all — confirms the death and sells. Buyers at least matching sells vetoes the sell
  //     (they're absorbing the dip) and disarms, so a later breach re-arms fresh.
  if (cfg.stopLoss > 0 && ratio <= 1 - cfg.stopLoss) {
    if (prot) noteBlock('stop-loss'); // PROTECT: the grace stop is stop-loss family — skipped, never arms while the flag is set
    else {
      if (stopArmedTs == null) stopArmedTs = now;
      if (now - stopArmedTs >= (cfg.stopGraceSec || 0) * 1000) {
        const flowAlive = cfg.stopFlowVeto > 0 && mark.buysM5 != null && mark.buysM5 > 2 && mark.sellsM5 <= mark.buysM5;
        if (!flowAlive) return out(1, `stop-loss (${((ratio - 1) * 100).toFixed(0)}%, confirmed after ${cfg.stopGraceSec}s grace, flow ${mark.buysM5 ?? '?'}b/${mark.sellsM5 ?? '?'}s)`);
        stopArmedTs = null;
      }
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
  //     PROBATION LEASH (user 2026-10-14, Musclecat): while probation is on
  //     (stallProbationSec > 0), reaching the deadline inside the range no longer sells —
  //     Musclecat sat flat past the 180s deadline, then dove to the −17% hard floor in ~20s
  //     (−0.0169) because nothing owned the space between "stalled" and "floored" (the dip
  //     stop is off). Instead the position goes on probation: a tight leash (stallLeashPct,
  //     on `move` like the stall itself) sells a dive instantly; breaking above the range top
  //     clears probation — the coin is working, the normal stack resumes; and the outer
  //     deadline stallProbationSec, anchored to ENTRY (not to when probation began), sells
  //     whatever is still in the range there. Probation off (stallProbationSec = 0) restores
  //     the original sell-at-the-deadline line, unchanged.
  const stallBandUp = cfg.stallBandUpPct ?? cfg.stallBandPct;
  const heldSec = heldMin * 60;
  // TAKEOVER: after a release, the stall/probation clock re-anchors to the release
  // moment (pos.stallBaseTs, set by bot.js releasePosition) — the takeover window
  // never counts toward the prove-itself deadlines. Positions never released (the
  // field absent) judge from entry exactly as before; the bleed below keeps the
  // true age (heldSec) — only the stall/probation deadlines re-anchor.
  const stallHeldSec = (now - (pos.stallBaseTs || pos.entryTs)) / 1000;
  if (cfg.stallSec > 0 && !pos.tp1Done && stallHeldSec >= cfg.stallSec) {
    if ((cfg.stallProbationSec || 0) > 0) {
      if (probationSince == null) {
        // deadline reached inside the range: probation starts, no sell
        if (move >= 1 - cfg.stallBandPct && move <= 1 + stallBandUp) { probationSince = now; return out(0, null); }
      } else if (cfg.stallLeashPct > 0 && move <= 1 - cfg.stallLeashPct) {
        // the leash is a fail-safe: confirmed, not instant (EXIT_CONFIRM_SEC). While its
        // pending runs, the position is NOT sold from here — but probation EXPIRY below is
        // a time expiry, not a breakdown trigger, and stays unconfirmed: it still sells on
        // this very check if the deadline has passed, as any other exit would.
        const d = failSafe('leash', `probation leash (${((move - 1) * 100).toFixed(1)}% after stall deadline)`);
        if (d) return d;
        if (stallHeldSec >= cfg.stallProbationSec) return out(1, `probation expired (still in entry range at ${cfg.stallProbationSec}s, ${((move - 1) * 100).toFixed(1)}%)`);
      } else if (move > 1 + stallBandUp) {
        probationSince = null; // breakout: probation over — the sections below judge normally
        cancelPending('leash');
      } else if (stallHeldSec >= cfg.stallProbationSec) {
        return out(1, `probation expired (still in entry range at ${cfg.stallProbationSec}s, ${((move - 1) * 100).toFixed(1)}%)`);
      } else {
        cancelPending('leash'); // on probation, back above the leash line: a pending leash sell is disarmed
      }
      // else: on probation, in range, leash/expiry not met — no exit from this section.
    } else if (move >= 1 - cfg.stallBandPct && move <= 1 + stallBandUp) {
      return out(1, `stall (in entry range at ${cfg.stallSec}s, ${((move - 1) * 100).toFixed(1)}%)`);
    }
  }

  // 4c. break-even ratchet (user 2026-10-14, "Build it — arm at +5%", guarding UNDER the TP
  //     ladder): mined from the user's own pre-TP1 closes — of 22 measurable positions
  //     reconstructed candle-by-candle, EVERY one that peaked >= +5% on the realizable move
  //     and then returned to break-even closed red (9 of 9, ~0.142 SOL of losses at a +5%
  //     arm; DOG peaked +22% and died at the old hard floor, LURK peaked +28% and closed
  //     -0.018). So once the tracked peak move (peakMove, judged on `move` like the stall,
  //     never the raw chart) reaches beArmPct, the trade can no longer become a loser: a
  //     fall back to beTriggerPct sells the FULL position at ~scratch — the +2% cushion over
  //     break-even exists so the executed fill lands at true scratch after the sell's own
  //     slippage (user approved +1-2%). Pre-TP1 ONLY: once TP1 fires, the ladder's own
  //     machinery (post-TP1 trail with its entry floor) owns the remainder and this never
  //     fires. Judged on the position's own peak path, independent of the stall/probation
  //     timeline — it can fire inside the first minute. It sits AFTER the stall block so a
  //     probationed position keeps the leash's own label on a deep dive (the leash's -7%
  //     condition is met first inside 4b), while an armed position on probation still
  //     scratches here when it fades to the trigger line. Arming needs no extra persisted
  //     state: it derives from peakMove, which bot.js already persists every check.
  //     Arming requires the position's OWN recorded peakMove: a position carrying none
  //     (legacy) never arms — the peakRatio-derived seed used elsewhere would fake a
  //     breakout off the round-trip (peakRatio floored at 1 / base < 1), so the ratchet
  //     fails open on untracked peaks like every other sampled-data check in this bot.
  //     beArmPct = 0 disables the ratchet. (The mining undercounts the shakeout cost —
  //     winners that dipped to break-even and then ran usually TP1'd out of the measured
  //     set — the user took the +5% arm with that caveat on the table.)
  //     Confirmation (user 2026-10-14): as a fail-safe, the ratchet sells through failSafe —
  //     with EXIT_CONFIRM_SEC > 0 the trigger must hold continuously across the window (a
  //     recovery back above the trigger line cancels via the else-branch below); the reason
  //     string is built fresh on the selling check, exactly as before.
  if (!pos.tp1Done && cfg.beArmPct > 0 && pos.peakMove != null && peakMove >= 1 + cfg.beArmPct && move <= 1 + cfg.beTriggerPct) {
    if (prot) noteBlock('ratchet'); // PROTECT: "no ratchet" — skipped; its pending was already dropped from the returned state above
    else {
      const pctFmt = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
      const d = failSafe('ratchet', `break-even ratchet (peaked ${pctFmt(peakMove - 1)}, back to ${pctFmt(move - 1)})`);
      if (d) return d;
      // pending: fall through — the bleed section and everything below still judge this check
    }
  } else {
    cancelPending('ratchet');
  }

  // 4d. bleed exit (user 2026-10-14, "Still-falling test — down 7%+ and not recovering"):
  //     the probation leash (4b) only exists for a coin that sat inside the entry band at the
  //     stall deadline — TAILOOR never did, and bled to -52% over ~6 minutes with no exit
  //     owning it (the user cut it by hand). This frees the leash from the band: past the
  //     prove-itself window (bleedMinAgeSec — before it, the older exits judge alone), ANY
  //     position down bleedPct or more on `move` sells in full IF it is still falling — the
  //     current move at/below the move bleedLookbackSec ago, on the position's own per-check
  //     move history. A coin that dipped and is recovering (current move back above the
  //     lookback print) is left alone — that is the whole test. No reference reading at
  //     least ~45s old (e.g. just after a restart) = no fire yet. No tp1Done exclusion:
  //     post-TP1 the trails judge first and these prints are rarely reachable there.
  //     It sits after 4b/4c, so a probationed dive keeps the leash's own label and an
  //     armed ratchet fade keeps the ratchet's. bleedPct = 0 disables the exit.
  //     Confirmation (user 2026-10-14): as a fail-safe, the bleed sells through failSafe —
  //     the FULL condition, still-falling leg included, is re-tested fresh on every check of
  //     the window; a print that is merely still ≤ −bleedPct but recovering (current move
  //     back above the lookback reference) fails the leg and cancels the pending sell.
  let bleedFires = false;
  if (cfg.bleedPct > 0 && heldSec >= (cfg.bleedMinAgeSec || 0) && move <= 1 - cfg.bleedPct) {
    const target = now - (cfg.bleedLookbackSec || 60) * 1000;
    let ref = null;
    for (const h of pos.moveHist || []) {
      if (!h || now - h.ts < 45000) continue; // the reference must be a real lookback, not the last few checks
      if (ref == null || Math.abs(h.ts - target) < Math.abs(ref.ts - target)) ref = h;
    }
    bleedFires = !!(ref && move <= ref.move);
  }
  if (bleedFires) {
    const d = failSafe('bleed', `bleed exit (${((move - 1) * 100).toFixed(1)}% and still falling)`);
    if (d) return d;
    // pending: fall through — the sections below still judge this check
  } else {
    cancelPending('bleed');
  }

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
