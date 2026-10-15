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

// EXIT-STACK STRIP (user order 2026-10-15 ~17:05 EDT — the user lifted his own exit
// freeze for this): the stack is reduced to the TP ladder (TP1 adaptive / TP2 /
// moonbag trail), the post-TP1 middle trail (3d), Tratchet (4c) and the 10-minute
// momentum-failure dead check (5), so positions get unrestrained time and produce
// clean, untruncated path data; the user accepts losing on some sells as the cost.
// The mechanisms flagged below are DISABLED IN CODE: their sections remain in
// place for reversibility, but the gates make them incapable of firing regardless
// of cfg/env values — re-enabling one is a code change, never a knob flip.
//   stopFamily     — 2a dip stop, 2a2 hard floor, 2b grace stop (the early
//                    below-entry stop family: the "instant stop" lineage)
//   stallProbation — 4b stall deadline sell + probation leash / expiry
//   deadflow       — 4d-pre dead-flow exit and its arming
//   bleed          — 4d bleed exit
//   genericTrail   — 4 trailing stop
//   profitLock     — 4a profit lock
//   modestBranch   — two-path branching on the TP1 lane: 3a modest target/split
//                    and the 4e kill zone. The lane STAMP on the TP1 decision
//                    (pathClass / killZoneOverlay) stays as record-only
//                    journaling; nothing below branches on it.
const STRIP = {
  stopFamily: true,
  stallProbation: true,
  deadflow: true,
  bleed: true,
  genericTrail: true,
  profitLock: true,
  modestBranch: true,
};

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
  // STRIP (stopFamily): the breach is never even registered — no floor state accrues.
  const hardBreached = !STRIP.stopFamily && cfg.stopHardPct > 0 && ratio <= 1 - cfg.stopHardPct;
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
  // Two-path redesign state (user 2026-10-15, variant c): the kill-zone record
  // ({armed, entries}) and the POST-TP1 peak of `move` — both persisted by the
  // caller alongside exitPending. The peak is tracked per check once TP1 has
  // banked (the TP1 fire check itself still reads tp1Done=false here, so the
  // tracker seeds on the first judged check after the bank). A position with no
  // pathClass (opened before this build) is never modest and carries no overlay —
  // the new sections simply never engage for it.
  let killZone = (pos.killZone && typeof pos.killZone === 'object') ? { armed: !!pos.killZone.armed, entries: pos.killZone.entries || 0 } : null;
  let postTp1PeakMove = pos.postTp1PeakMove != null ? pos.postTp1PeakMove : null;
  if (pos.tp1Done) postTp1PeakMove = Math.max(postTp1PeakMove ?? 0, move);
  const killzoneEvents = [];
  // STRIP (modestBranch): the lane no longer branches anything — a modest-classified
  // remainder judges through the plain ladder exactly like any other remainder.
  const modestActive = !STRIP.modestBranch && !!pos.tp1Done && pos.pathClass === 'modest';
  const zoneEligible = !STRIP.modestBranch && !!pos.tp1Done && !pos.tp2Done && cfg.killZoneFloorPct > 0 && (modestActive || !!pos.killZoneOverlay);
  // Dead-flow-at-altitude arming (user 2026-10-15): a persisted flag on the
  // position, set on the first check the realizable peak move (peakMove — the
  // same series the ratchet arms from) reaches the arm line while the position
  // is still pre-TP1; counted once via deadflowEvents. Arming is bookkeeping
  // only — section 4d-pre judges the fire fresh from the flow/move history on
  // every check. Window 0 (rule off) never arms, and post-TP1 positions are
  // out of scope: their stack owns them.
  let deadflowArmed = !!pos.deadflowArmed;
  const deadflowEvents = [];
  if (!STRIP.deadflow && !pos.tp1Done && cfg.deadflowWindowSec > 0 && !deadflowArmed && peakMove >= 1 + cfg.deadflowArmPct) {
    deadflowArmed = true;
    deadflowEvents.push({ type: 'armed' });
  }
  // PROTECT switch (user 2026-10-15, "just the stop loss… no ratchet", "no SL until I
  // say"): a one-time, per-position flag set via POST /protect while the user rides a
  // coin himself. While protected, ONLY the stop-loss family (2a dip stop, 2a2 hard
  // floor, 2b grace stop), the break-even ratchet (4c) and the kill zone (4e — the
  // redesign widened the scope by exactly that one rule, user 2026-10-15) are
  // skipped — the momentum failure, time stops and the full TP ladder judge exactly
  // as normal. (Since the 2026-10-15 strip, the stop family, kill zone, bleed,
  // probation/stall and the trails are off for EVERY position, protected or not;
  // the only suppression with live effect left is the ratchet's.) The flag holds for the
  // LIFE of the position: no timeout, no auto-expiry; it clears only when the
  // position closes or when POST /unprotect clears it (bot.js owns both, and
  // unprotect also resets the kill-zone record so the zone re-arms fresh). The
  // stop's armed state and any ratchet/kill-zone pending are dropped from the
  // returned state below so none can execute while the flag is set; bleed/leash
  // pendings pass through untouched. Each suppression is reported on the decision
  // as protectedBlock (the first suppressed kind, once per check) for bot.js to
  // count in stats.protect.
  const prot = !!pos.protected;
  let protectedBlock = null;
  const noteBlock = (kind) => { if (prot && !protectedBlock) protectedBlock = kind; };
  if (prot) {
    stopArmedTs = null; floorChecks = 0; floorSince = null;
    if (exitPending != null) { delete exitPending.ratchet; delete exitPending.killzone; }
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
  const out = (fraction, reason) => ({ fraction, reason, newPeak: peakRatio, newPeakMove: peakMove, ratio, stallSince: null, stopArmedTs, floorChecks, floorSince, probationSince, tp1Arm, moveHist, exitPending, exitConfirmEvents, protectedBlock, killZone, postTp1PeakMove, killzoneEvents, deadflowArmed, deadflowEvents });
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
  //     STRIP (stopFamily): disabled in code — the section below can never fire.
  if (!STRIP.stopFamily && cfg.dipStopPct > 0 && move <= 1 - cfg.dipStopPct) {
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
  if (!STRIP.stopFamily && hardBreached) { // STRIP (stopFamily): the hard floor can never fire
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
  if (!STRIP.stopFamily && cfg.stopLoss > 0 && ratio <= 1 - cfg.stopLoss) { // STRIP (stopFamily): the grace stop can never arm or fire
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
      if (fire) {
        // Two-path classification (user 2026-10-15, variant c): the fire's realized
        // gain — the same `gain` this sell record prints — picks the remainder's
        // path: inside [modestMinPct, modestMaxPct] → MODEST; above → LADDER;
        // below → LADDER plus the kill-zone overlay (4e). Stamped on the decision
        // for bot.js to persist on the position and journal on this sell + the close.
        const pathClass = gain > cfg.modestMaxPct ? 'ladder' : (gain >= cfg.modestMinPct ? 'modest' : 'ladder');
        const killZoneOverlay = gain < cfg.modestMinPct;
        return { ...out(cfg.tp1Frac, `TP1 +${(gain * 100).toFixed(0)}% (adaptive: ${fire})`), tp1: true, tp1Arm: null, pathClass, killZoneOverlay };
      }
    }
  }

  // 3a. MODEST TARGET + SPLIT (two-path redesign, user 2026-10-15): a modest
  //     STRIP (modestBranch): modestActive is forced false above, so this section
  //     can never fire — the remainder judges through the plain ladder instead.
  //     remainder is NOT trailed (3b / 3d-pre / 3d / 4 all skip it below) — it rides
  //     to this target on `move`. At the target the remainder SPLITS: bank
  //     modestSplitBankFrac of it on this sell, and the surviving slice converts
  //     to the ladder path (bot.js flips pos.pathClass on the modestSplit flag),
  //     where TP2, the trails and the moonbag judge it under the ladder's existing
  //     semantics and fraction conventions. A profit event: protect does NOT
  //     suppress it; takeover returned long before this section.
  if (modestActive && cfg.modestTargetPct > 0 && move >= 1 + cfg.modestTargetPct) {
    return { ...out(cfg.modestSplitBankFrac, `modest target +${(cfg.modestTargetPct * 100).toFixed(0)}% — banked ${(cfg.modestSplitBankFrac * 100).toFixed(0)}% of remainder, rest to ladder`), modestSplit: true };
  }

  // 3b. TP2: the second bank, at tp2Pct — sells tp2Frac of the ORIGINAL position (converted to a
  //     fraction of what remains). Fires on the way up, near the level, before the dump candle.
  //     An un-split MODEST remainder never reaches this section's rule (3a owns it until the split).
  if (!modestActive && pos.tp1Done && !pos.tp2Done && !pos.noTp && cfg.tp2Frac > 0 && gain >= cfg.tp2Pct) {
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
  if (!modestActive && pos.tp1Done && !pos.tp2Done && cfg.tp2RejectZone > 0 && peakGain >= cfg.tp2RejectZone && ratio <= peakRatio * (1 - cfg.tp2RejectDrop)) return out(1, `TP2 rejection (peak +${(peakGain * 100).toFixed(0)}%, now ${((ratio - 1) * 100).toFixed(1)}%)`);

  // 3d. post-TP1 trail (middle stage, pre-TP2): trail the rest tpTrailPct below its peak with a hard
  //     floor at entry — sell everything if it gives back the trail or fades back to cost.
  //     MODEST remainders skip it — their downside is the kill zone (4e), not a trail.
  if (!modestActive && pos.tp1Done && !pos.tp2Done && (ratio <= peakRatio * (1 - cfg.tpTrailPct) || ratio <= 1)) return out(1, `post-TP1 trail (peak ${(peakRatio).toFixed(2)}x, now ${((ratio - 1) * 100).toFixed(1)}%)`);

  // 4. trailing stop once armed (never on the moonbag — it has its own wider trail, 3c;
  //    never on an un-split modest remainder either — see 3d)
  //    STRIP (genericTrail): disabled in code — can never fire.
  if (!STRIP.genericTrail && !modestActive && !pos.tp2Done && peakRatio >= 1 + cfg.trailArm && ratio <= peakRatio * (1 - cfg.trailPct)) return out(1, `trailing stop (${(cfg.trailPct * 100).toFixed(0)}% off peak ${(peakRatio).toFixed(2)}x)`);

  // 4a. profit lock: once up lockArm+ after costs, don't let it round-trip — sell if it gives back (1 - lockKeep) of its
  //     best real gain. Scales with the move: best +40% → sells at +20%; best +200% → sells at +100% (lockKeep 0.5).
  //     Skips the moonbag (post-TP2): the ladder, not the lock, governs the bag.
  //     STRIP (profitLock): disabled in code — can never fire.
  if (!STRIP.profitLock && !pos.tp2Done && cfg.lockKeep > 0 && peakGain >= cfg.lockArm && gain <= peakGain * cfg.lockKeep) return out(1, `profit lock (best +${(peakGain * 100).toFixed(0)}%, now +${(gain * 100).toFixed(0)}% after fees)`);

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
  // STRIP (stallProbation): the whole stall/probation block — deadline sell, the
  // probation leash and the probation expiry — is disabled in code and can never fire.
  if (!STRIP.stallProbation && cfg.stallSec > 0 && !pos.tp1Done && stallHeldSec >= cfg.stallSec) {
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

  // 4d-pre. DEAD FLOW AT ALTITUDE (user 2026-10-15): the founding case is Scout
  //     (Anti-AI Dog) — spiked to ~+12% realizable, the buys flatlined for
  //     minutes while the price chopped, and it round-tripped to −0.4% where
  //     probation expiry closed it red; a sell inside the stall banks ~+10%.
  //     Nothing else owned that shape: the ratchet arms at +15% and even armed
  //     waits for +5%; TP1's strength test starts at +20%; momentum failure
  //     needs 10 minutes of death. This rule owns it, PRE-TP1 ONLY (post-TP1
  //     remainders belong to the trails / kill zone). Placement: after the TP
  //     ladder — a firing TP1 on the same check has already returned and wins —
  //     and after the ratchet, whose armed confirmation owns a fade it is
  //     already judging (the rule waits while a ratchet pending runs).
  //     ARM: the position's peak `move` reached 1 + deadflowArmPct (state prep
  //     above, persisted as pos.deadflowArmed).
  //     TRIGGER — all three over a rolling deadflowWindowSec window, judged on
  //     the ~4s checks from the position's OWN recorded series:
  //       1. the buy count barely moves: flowHist's per-check `buys` (the
  //          view's trailing-5m buy count bot.js records every check — the
  //          closest per-check flow series the bot keeps) rises by at most
  //          deadflowMaxBuyDelta across the window. A flatlined coin's count
  //          only ages out flat-to-down; one stray buy is tolerated.
  //       2. no new peak inside the window: the best `move` printed since the
  //          window opened does not exceed the peak as of the window's start
  //          (both off moveHist, the position's own per-check move prints).
  //       3. the price actually stopped pushing: the current `move` sits at
  //          least deadflowPeakGapPct below that window-start peak — and the
  //          window-start peak itself must be at/above the arm line, so the
  //          stall being judged is a stall AT ALTITUDE, not a later sag.
  //     The window IS the confirmation — 45s of accumulated dead flow, not one
  //     bad tick — so the fire is instant: no exitPending, no extra grace.
  //     FAIL-CLOSED: the window must be fully covered (flow + move samples at
  //     or just before its start, a fresh current sample, buy counts present
  //     at both ends) — missing data never fires, the TP1-strength convention.
  //     PROTECT suppresses the fire like the ratchet's (noteBlock — it is a
  //     profit-side auto exit); TAKEOVER returned long before this section.
  if (!STRIP.deadflow && !pos.tp1Done && cfg.deadflowWindowSec > 0 && deadflowArmed) { // STRIP (deadflow): can never fire
    const winMs = cfg.deadflowWindowSec * 1000;
    const winStart = now - winMs;
    let fStart = null, fNow = null;
    for (const s of pos.flowHist || []) {
      if (!s || s.ts == null) continue;
      if (s.ts <= winStart && (fStart == null || s.ts > fStart.ts)) fStart = s;
      if (fNow == null || s.ts > fNow.ts) fNow = s;
    }
    let peakAtStart = null, peakInWindow = null;
    for (const h of moveHist) {
      if (h.ts <= winStart) peakAtStart = peakAtStart == null ? h.move : Math.max(peakAtStart, h.move);
      else peakInWindow = peakInWindow == null ? h.move : Math.max(peakInWindow, h.move);
    }
    const covered = fStart != null && fNow != null && winStart - fStart.ts <= 12000 && now - fNow.ts <= 12000
      && fStart.buys != null && fNow.buys != null && peakAtStart != null && peakInWindow != null;
    if (covered && peakAtStart >= 1 + cfg.deadflowArmPct) {
      const buyDelta = fNow.buys - fStart.buys;
      if (buyDelta <= cfg.deadflowMaxBuyDelta && peakInWindow <= peakAtStart + 1e-9 && move <= peakAtStart - cfg.deadflowPeakGapPct) {
        if (prot) noteBlock('dead flow');
        else if (exitPending != null && exitPending.ratchet != null) {
          // the ratchet's confirmation window owns this fade — it sells or cancels first
        } else {
          deadflowEvents.push({ type: 'fired' });
          return out(1, `dead flow at altitude (${move >= 1 ? '+' : ''}${((move - 1) * 100).toFixed(1)}%, ${Math.max(0, buyDelta)} new buys in ${cfg.deadflowWindowSec}s, peak stalled)`);
        }
      }
    }
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
  // STRIP (bleed): disabled in code — bleedFires can never become true and the
  // whole fire/cancel block below is gated off with it, so a stale pre-strip
  // bleed pending on a carried-over position passes through untouched and inert.
  let bleedFires = false;
  if (!STRIP.bleed && cfg.bleedPct > 0 && heldSec >= (cfg.bleedMinAgeSec || 0) && move <= 1 - cfg.bleedPct) {
    const target = now - (cfg.bleedLookbackSec || 60) * 1000;
    let ref = null;
    for (const h of pos.moveHist || []) {
      if (!h || now - h.ts < 45000) continue; // the reference must be a real lookback, not the last few checks
      if (ref == null || Math.abs(h.ts - target) < Math.abs(ref.ts - target)) ref = h;
    }
    bleedFires = !!(ref && move <= ref.move);
  }
  if (!STRIP.bleed) {
    if (bleedFires) {
      const d = failSafe('bleed', `bleed exit (${((move - 1) * 100).toFixed(1)}% and still falling)`);
      if (d) return d;
      // pending: fall through — the sections below still judge this check
    } else {
      cancelPending('bleed');
    }
  }

  // 4e. KILL ZONE (two-path redesign, user 2026-10-15): the modest remainder's
  //     STRIP (modestBranch): zoneEligible is forced false above — this section
  //     can never arm, count an entry, or fire.
  //     downside floor, overlaid on sub-band ladder remainders (zoneEligible,
  //     computed in the state prep). Judged on `move`, never the chart:
  //     - ARMING: the zone is inert until the post-TP1 peak (postTp1PeakMove)
  //       reaches killZoneArmMult. A dip before that accrues NO zone state at
  //       all — the bleed/leash window owns it, exactly as before this section
  //       existed (FEEMAIL's class can never start inside an armed zone).
  //     - FIRST ENTRY (armed, move at/below 1 + killZoneFloorPct): the same 10s
  //       confirmation window the fail-safes use, on the same exitPending slot
  //       under kind 'killzone'. Recovery above the floor inside the window
  //       cancels it and COUNTS the entry; still at/below at lapse, the FULL
  //       remainder sells at market.
  //     - SECOND ENTRY after a cancelled window: instant sell, no window — the
  //       window already forgave one wick ("kill it on the way down").
  //     - SLOT PRECEDENCE: the zone never arms a window while a fail-safe
  //       pending (leash/ratchet/bleed) owns the slot — it waits, counts no
  //       entry, and re-judges next check; a zone window already running still
  //       completes on its own clock. One pending, one owner, one sell.
  //     - PROTECT: triggers are suppressed like the stop family (noteBlock; the
  //       pending itself was already dropped in the protect block above).
  //       Arming keeps tracking underneath, so an unprotect finds live state —
  //       bot.js additionally resets the record so entries start fresh.
  //     EXIT_CONFIRM_SEC = 0 (or a legacy position with no exitPending) restores
  //     the pre-layer behavior for the zone too: the first entry sells at once.
  if (zoneEligible) {
    const kz = killZone || { armed: false, entries: 0 };
    const kzFloor = 1 + cfg.killZoneFloorPct;
    if (!kz.armed && postTp1PeakMove != null && postTp1PeakMove >= cfg.killZoneArmMult) {
      kz.armed = true;
      killzoneEvents.push({ type: 'armed' });
    }
    if (kz.armed) {
      if (move <= kzFloor) {
        if (prot) noteBlock('kill zone');
        else if (kz.entries >= 1) {
          killzoneEvents.push({ type: 'reentry' });
          return out(1, `kill zone (re-entry at ${((move - 1) * 100).toFixed(1)}% — second dip into the zone, no window)`);
        } else if (exitPending != null && exitPending.killzone != null) {
          if (!((cfg.exitConfirmSec || 0) > 0) || now - exitPending.killzone >= cfg.exitConfirmSec * 1000) {
            delete exitPending.killzone;
            exitConfirmEvents.push({ type: 'confirmed', kind: 'killzone' });
            killzoneEvents.push({ type: 'fired' });
            return out(1, `kill zone (move ${((move - 1) * 100).toFixed(1)}% held at/below the +${(cfg.killZoneFloorPct * 100).toFixed(0)}% floor through the ${cfg.exitConfirmSec}s window)`);
          }
          // window running, condition holds: fall through — later sections still judge this check
        } else if (!((cfg.exitConfirmSec || 0) > 0) || exitPending == null) {
          killzoneEvents.push({ type: 'fired' });
          return out(1, `kill zone (move ${((move - 1) * 100).toFixed(1)}% at/below the +${(cfg.killZoneFloorPct * 100).toFixed(0)}% floor)`);
        } else if (Object.keys(exitPending).length === 0) {
          exitPending.killzone = now; // first entry: arm the window; later sections still judge this check
        }
        // else: a fail-safe pending owns the slot — the zone waits, no entry counted
      } else if (exitPending != null && exitPending.killzone != null) {
        // recovery above the floor inside the window: cancel it and count the entry
        delete exitPending.killzone;
        exitConfirmEvents.push({ type: 'cancelled', kind: 'killzone' });
        killzoneEvents.push({ type: 'cancelled' });
        kz.entries = 1;
      }
    }
    // the record only exists once the zone has armed or counted an entry —
    // before that, no zone state accrues at all (the returned killZone stays null)
    if (killZone != null || kz.armed || kz.entries > 0) killZone = kz;
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
