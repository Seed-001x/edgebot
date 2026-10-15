// detect.js — pure entry detectors. No network, no clock (now is passed in), fully unit-testable.
//
//   eligible(view)  → list of reasons the coin is NOT tradable at all (empty = ok)
//   detect(view, samples, cfg, now) → null | { setup, strength, metrics }
//
// 'pop'   : price rose ≥popGainPct inside popWindowSec measured from the window LOW, is still near the
//           window high (not already dumping), isn't already absurdly extended, with real buy-side flow.
//           This is the flat→vertical move that the 30-minute-window detectors can never catch.
// 'trend' : a runner the market already ranks hot (multi-hour move + heavy volume) that is still green
//           over the last 5 minutes. Uses DexScreener's own priceChange so it works the moment a coin is
//           discovered — no warm-up history needed.

export function eligible(v, cfg, now = Date.now()) {
  const r = [];
  if (!v || !(v.price > 0)) return ['no price'];
  if (!(v.mc > 0)) r.push('no market cap');
  else {
    if (v.mc < cfg.minMc) r.push(`mc $${Math.round(v.mc)} < $${cfg.minMc}`);
    if (v.mc > cfg.maxMc) r.push(`mc $${Math.round(v.mc)} > $${cfg.maxMc}`);
  }
  if (v.liq < cfg.minLiqUsd) r.push(`liq $${Math.round(v.liq)} < $${cfg.minLiqUsd}`);
  if (v.mc > 0 && v.liq / v.mc < cfg.minLiqToMc) r.push(`liq is ${((v.liq / v.mc) * 100).toFixed(1)}% of mc < ${(cfg.minLiqToMc * 100).toFixed(0)}%`);
  // Fresh pools (just graduated from pump.fun / just launched): early holders dump into the first buyers.
  // Negative age (clock skew) is ignored rather than treated as young.
  if (cfg.minPairAgeMin > 0 && v.createdAt) {
    const ageMin = (now - v.createdAt) / 60000;
    if (ageMin >= 0 && ageMin < cfg.minPairAgeMin) r.push(`pool only ${ageMin.toFixed(0)}m old < ${cfg.minPairAgeMin}m`);
  }
  // Don't buy dead coins bouncing: if it's down 50%+ in the last hour, it's a dump, not an opportunity
  if (v.chgH1 != null && v.chgH1 <= -50) r.push(`down ${Math.round(v.chgH1)}% in 1h — dead bounce`);
  return r;
}

const buyRatio = (b, s) => (b + s > 0 ? b / (b + s) : null);

export function detect(v, samples, cfg, now) {
  if (eligible(v, cfg, now).length) return null;

  const ratio5 = buyRatio(v.buysM5, v.sellsM5);
  // B3 wash reject (shared): a small cap whose hourly volume is a multiple of its whole
  // market cap is being churned, not accumulated (Urara: $71k volH1 on a $15.6k cap).
  const washVol = cfg.trendMaxVolToMc > 0 && v.mc > 0 && v.mc < cfg.freshSmallMc && v.volH1 > cfg.trendMaxVolToMc * v.mc;

  // ---- POP ----
  const win = (samples || []).filter(s => now - s.ts <= cfg.popWindowSec * 1000);
  if (win.length >= 3 && win[win.length - 1].ts - win[0].ts >= 45000) {
    const last = win[win.length - 1].price;
    const low = Math.min(...win.map(s => s.price));
    const high = Math.max(...win.map(s => s.price));
    const gain = (last / low - 1) * 100;
    const draw = high > 0 ? (high - last) / high : 0;
    // the 5-minute window can't tell a breakout from a bounce off a crash, so also look at the last hour
    const hourHigh = Math.max(...(samples || []).filter(s => now - s.ts <= 3600000).map(s => s.price), last);
    const notCrashedH6 = !(cfg.popMaxDropH6 > 0 && v.chgH6 != null && v.chgH6 <= -cfg.popMaxDropH6);
    const notBouncing = notCrashedH6 && v.chgH1 != null && v.chgH1 >= cfg.popMinChgH1 && last >= hourHigh * (1 - cfg.popMaxBelowHigh);
    if (
      gain >= cfg.popGainPct && gain <= cfg.popMaxGainPct &&
      draw <= cfg.maxDrawFromPeak && notBouncing && !washVol &&
      v.volM5 >= cfg.popMinVolM5 &&
      v.buysM5 >= cfg.popMinBuysM5 &&
      ratio5 != null && ratio5 >= cfg.minBuyRatioM5 &&
      !(cfg.maxBuyRatioM5 > 0 && ratio5 >= cfg.maxBuyRatioM5)
    ) {
      return { setup: 'pop', strength: gain, metrics: { gainPct: +gain.toFixed(1), drawFromPeak: +draw.toFixed(3), buyRatioM5: +ratio5.toFixed(2), volH1: v.volH1, volM5: v.volM5 } };
    }
  }

  // ---- TREND ----
  // Freshness is judged on VOLUME, not price (user 2026-10-14): the runner must still be
  // trading heavily right now (5m volume), not a spike from 40 minutes ago that's just
  // drifting at the top on dead volume. A price-burst share-of-the-hour rule made steady
  // grinds with huge 5m volume invisible — volume is the freshness proof now.
  // PAUSED by default (B1, user 2026-10-13): tonight's trend went 0-for-9 (−0.091) while pop
  // produced the day's wins. TREND_ENABLED=1 revives it — with the B2–B5 guards below standing.
  if (cfg.trendEnabled) {
    // B2: the whole hour must be buy-dominated (a 0.75 ratio from 14 trades is not demand),
    // and the 5m window must hold enough trades for any ratio to mean anything.
    const ratioH1 = buyRatio(v.buysH1, v.sellsH1);
    const hourDemand = !(cfg.trendMinBuyRatioH1 > 0) || (ratioH1 != null && ratioH1 >= cfg.trendMinBuyRatioH1);
    const enoughTxns = !(cfg.trendMinTxnsM5 > 0) || ((v.buysM5 || 0) + (v.sellsM5 || 0) >= cfg.trendMinTxnsM5);
    // Volume freshness (user 2026-10-14, UNTXED): replaces the old price-share rule
    // (chgM5 >= chgH1 * ratio), which a grind could never pass. Missing volume = not fresh.
    const freshVol = !(cfg.trendFreshMinVolM5 > 0) || (v.volM5 || 0) >= cfg.trendFreshMinVolM5;
    // B5: dead-coin revival — an old pool suddenly up huge over 6h is a zombie pump, not a runner.
    const ageD = v.createdAt ? (now - v.createdAt) / 86400000 : 0;
    const revival = cfg.revivalMinAgeD > 0 && ageD >= cfg.revivalMinAgeD && v.chgH6 != null && v.chgH6 >= cfg.revivalMaxChgH6;
    if (
      v.chgH1 != null && v.chgM5 != null &&
      v.chgH1 >= cfg.trendMinH1 && v.chgH1 <= cfg.trendMaxH1 &&
      v.chgM5 >= cfg.trendMinM5 &&
      freshVol &&
      v.volH1 >= cfg.trendMinVolH1 &&
      v.buysM5 >= cfg.trendMinBuysM5 &&
      ratio5 != null && ratio5 >= cfg.trendMinBuyRatio &&
      !(cfg.maxBuyRatioM5 > 0 && ratio5 >= cfg.maxBuyRatioM5) &&
      !(cfg.trendMinMc > 0 && v.mc < cfg.trendMinMc) &&
      hourDemand && enoughTxns && !washVol && !revival
    ) {
    // don't buy a coin that already rolled over from a recent high
    const recent = (samples || []).filter(s => now - s.ts <= 15 * 60 * 1000);
    const high = recent.length ? Math.max(...recent.map(s => s.price)) : v.price;
    if (v.price >= high * 0.85) {
      return { setup: 'trend', strength: v.chgH1 / 10, metrics: { chgH1: v.chgH1, chgM5: v.chgM5, buyRatioM5: +ratio5.toFixed(2), volH1: v.volH1 } };
    }
    }
  }
  return null;
}

// ---- CHURN (dumped coin basing at its lows, user 2026-10-14) ----
// The Vwhale shape: a coin dumped hard, then sat at its lows while trade COUNT stayed
// hot (~180 tx/5m of two-way flow at support) — accumulation before any pop. Pop never
// fired: its buy ratio sat ~0.50 the whole recovery and price hadn't moved yet. This
// detector reads the bot's own samples and asks the opposite question of pop: not "did
// it just move?" but "did it stop falling while people kept trading it?"
//   dropped ≥ churnMinDropPct from the sampled peak to an ESTABLISHED low (set before
//   the stable window), no (materially) new low inside churnStableMin, current price
//   within churnLowBandPct of that low, the trailing-5m trade count sustained at/above
//   churnMinTxM5 across the last 3 samples, buy share ≥ churnMinBuyShare (two-way, not
//   a stampede out), and average trade size ≥ churnMinAvgUsd — the avg floor sits above
//   the botflow/dust hard-gate floors so wash churn can't qualify by construction.
export function detectChurn(v, samples, cfg, now) {
  if (!cfg.churnEnabled) return null;
  if (eligible(v, cfg, now).length) return null;
  const a = (samples || []).filter(s => s && s.price > 0);
  if (a.length < 4) return null;
  const last = a[a.length - 1];

  let peak = 0, peakTs = 0;
  for (const s of a) if (s.price > peak) { peak = s.price; peakTs = s.ts; }
  if (!(peak > 0)) return null;

  // The low must be ESTABLISHED: set before the stable window, and not materially
  // undercut inside it. A low printed minutes ago means it's still falling.
  const cutoff = now - cfg.churnStableMin * 60000;
  const before = a.filter(s => s.ts <= cutoff);
  if (!before.length) return null;
  let low = Infinity, lowTs = 0;
  for (const s of before) if (s.price < low) { low = s.price; lowTs = s.ts; }
  if (!(low > 0) || peakTs > lowTs) return null; // the drop must run peak → low, in that order
  const recent = a.filter(s => s.ts > cutoff);
  if (!recent.length) return null;
  const recentLow = Math.min(...recent.map(s => s.price));
  if (recentLow < low * 0.999) return null; // new low inside the stable window — still falling

  const dropPct = (peak - low) / peak * 100;
  if (dropPct < cfg.churnMinDropPct) return null;
  if (!(last.price <= low * (1 + cfg.churnLowBandPct / 100))) return null; // hugging the low, not recovering away from it

  // Sustained count: each of the last 3 samples carries a hot trailing-5m count
  // (rolling snapshots — sustained elevation is the intent, not disjoint windows).
  const last3 = a.slice(-3);
  for (const s of last3) if ((s.buysM5 || 0) + (s.sellsM5 || 0) < cfg.churnMinTxM5) return null;
  const tx = (last.buysM5 || 0) + (last.sellsM5 || 0);
  if (tx <= 0) return null;
  const share = (last.buysM5 || 0) / tx;
  if (share < cfg.churnMinBuyShare) return null;
  const avgUsd = (last.volM5 || 0) / tx;
  if (avgUsd < cfg.churnMinAvgUsd) return null;

  const lowAgeMin = (now - lowTs) / 60000;
  const metrics = { dropPct: +dropPct.toFixed(1), txM5: tx, buyShare: +share.toFixed(2), avgUsd: +avgUsd.toFixed(2), lowAgeMin: +lowAgeMin.toFixed(1) };
  return {
    setup: 'churn',
    strength: dropPct,
    metrics,
    label: `churn: -${Math.round(dropPct)}% off peak, basing ${Math.round(lowAgeMin)}m, ${tx} tx/5m, share ${share.toFixed(2)}`,
  };
}

// ---- LIFTOFF (coin lifting off a flat base, user 2026-10-14) ----
// The BEGINNING of an uptrend, not the move after it ran. UNTXED and CODE ground up
// for an hour (+121% / +73% on the hour in ~+1.5% price steps): pop waits for a
// vertical burst and trend's freshness is volume-based but its gain is hourly, so
// the first leg of a grind belonged to nobody. This detector reads the bot's own
// samples for that first leg: a tight flat BASE, then a stepped climb off it with
// rising lows, building buy pressure and picking-up trade activity — fired while
// the price is still within liftoffMaxGainPct of the base low (early by
// construction; beyond that band pop/trend own the coin). Churn is the sibling:
// it fires at the lows BEFORE any move, liftoff fires on the first confirmed leg up.
//   windows (all inside the last liftoffLookbackMin): base = samples older than
//   liftoffClimbMin; climb = the last liftoffClimbMin. Base range (high−low)/low
//   must be ≤ liftoffBaseRangePct; current price must sit between liftoffMinGainPct
//   and liftoffMaxGainPct above the base low; the climb's lows must rise (below);
//   the latest view's 5m buy share must be ≥ liftoffMinBuyShare; and the climb
//   window's average per-sample trade count (buysM5+sellsM5 snapshots — the same
//   fields churn reads) must be ≥ liftoffTxnBoost × the base window's average.
//   The latest view's 5m volume must also clear liftoffMinVolM5: trade COUNT
//   alone lets a dozen dust trades fake a crowd (user 2026-10-14 — STUDIO
//   fired on ~$543 of 5m volume), so the twitch needs dollars behind it too.
export function detectLiftoff(v, samples, cfg, now) {
  if (!cfg.liftoffEnabled) return null;
  if (eligible(v, cfg, now).length) return null;
  const a = (samples || []).filter(s => s && s.price > 0);
  if (a.length < 6) return null;
  const last = a[a.length - 1];

  const look = a.filter(s => now - s.ts <= cfg.liftoffLookbackMin * 60000);
  if (look.length < 6) return null;
  // Not enough sampled history to call anything a "base" (fail closed, like the
  // fresh-history guard: thin history lies).
  if (last.ts - look[0].ts < cfg.liftoffMinHistoryMin * 60000) return null;
  const climbStart = now - cfg.liftoffClimbMin * 60000;
  const base = look.filter(s => s.ts < climbStart);
  const climb = look.filter(s => s.ts >= climbStart);
  if (base.length < 3 || climb.length < 3) return null;

  // BASE: the pre-climb range must be tight — sideways, not a slow bleed or a ramp.
  let baseLow = Infinity, baseHigh = 0;
  for (const s of base) { if (s.price < baseLow) baseLow = s.price; if (s.price > baseHigh) baseHigh = s.price; }
  if (!(baseLow > 0)) return null;
  const baseRangePct = (baseHigh - baseLow) / baseLow * 100;
  if (baseRangePct > cfg.liftoffBaseRangePct) return null;

  // CLIMB: off the base low, but still early.
  const gainPct = (last.price / baseLow - 1) * 100;
  if (gainPct < cfg.liftoffMinGainPct || gainPct > cfg.liftoffMaxGainPct) return null;

  // RISING STRUCTURE: the climb window is split into 3 consecutive equal time
  // chunks; each chunk's minimum price must be >= the previous chunk's minimum,
  // allowing a 0.5% tolerance for print noise (chunkMin[i+1] >= chunkMin[i] * 0.995).
  // A single wick up fails here — its later chunks dip back to the earlier lows —
  // even when the net gain passes. An empty chunk can't be judged: fail closed.
  const third = (cfg.liftoffClimbMin * 60000) / 3;
  const chunkMin = [Infinity, Infinity, Infinity];
  for (const s of climb) {
    const i = Math.min(2, Math.floor((s.ts - climbStart) / third));
    if (s.price < chunkMin[i]) chunkMin[i] = s.price;
  }
  if (chunkMin.some(m => !isFinite(m))) return null;
  const TOL = 0.005;
  if (chunkMin[1] < chunkMin[0] * (1 - TOL) || chunkMin[2] < chunkMin[1] * (1 - TOL)) return null;

  // BUY PRESSURE: the latest view's trailing-5m buy share.
  const ratio5 = buyRatio(v.buysM5 || 0, v.sellsM5 || 0);
  if (ratio5 == null || ratio5 < cfg.liftoffMinBuyShare) return null;

  // DOLLAR VOLUME (user 2026-10-14): the twitch must carry real money — the
  // legs above count trades, and a dozen dust trades pass them (STUDIO fired
  // on ~$543 of 5m volume). Same shape as trend's volume-freshness leg:
  // missing volume does not clear the floor.
  if (cfg.liftoffMinVolM5 > 0 && (v.volM5 || 0) < cfg.liftoffMinVolM5) return null;

  // ACTIVITY PICKUP: the climb must be trading harder than the base did.
  const txAvg = (arr) => arr.reduce((acc, s) => acc + (s.buysM5 || 0) + (s.sellsM5 || 0), 0) / arr.length;
  const baseTx = txAvg(base), climbTx = txAvg(climb);
  if (!(baseTx > 0) || !(climbTx >= cfg.liftoffTxnBoost * baseTx)) return null;

  const baseMin = Math.round((base[base.length - 1].ts - base[0].ts) / 60000);
  const metrics = { gainPct: +gainPct.toFixed(1), baseRangePct: +baseRangePct.toFixed(1), buyRatioM5: +ratio5.toFixed(2), volM5: v.volM5, txnBoost: +(climbTx / baseTx).toFixed(2), baseMin };
  return {
    setup: 'liftoff',
    // Strength is the gain off the base low itself (10–35 by construction) — the
    // same scale as pop's window gain, so a liftoff roughly ties a weak pop and
    // never outranks a strong one when candidates compete for the per-tick slots.
    // It is the earliest, softest signal by design.
    strength: gainPct,
    metrics,
    label: `liftoff: +${Math.round(gainPct)}% off ${baseMin}m base, ratio ${ratio5.toFixed(2)}`,
  };
}

// ---- FAST POP (live trade stream) ----
// Samples are individual stream trades: { ts, price, sol, side: 'buy'|'sell' } with
// price in SOL per token as printed by the trade itself. Judged over a short rolling
// window (default 90s): a real move must be big from the window low, still printing
// (recent trades), buy-dominated in LIVE flow (not a trailing average), and not
// already rolling over from the window peak. Returns the same signal shape as the
// classic pop so the whole downstream pipeline (gates, risk, journal) is shared.
export function fastPop(samples, cfg, now) {
  const win = (samples || []).filter(s => now - s.ts <= cfg.fastPopWindowSec * 1000 && s.price > 0);
  if (win.length < cfg.fastPopMinTrades) return null;
  const last = win[win.length - 1];
  if (now - last.ts > cfg.fastPopRecentSec * 1000) return null; // the stream went quiet — the moment passed
  const recent = win.filter(s => now - s.ts <= cfg.fastPopRecentSec * 1000);
  if (recent.length < cfg.fastPopMinRecent) return null;
  const low = Math.min(...win.map(s => s.price));
  const high = Math.max(...win.map(s => s.price));
  if (!(low > 0) || !(high > 0)) return null;
  const gain = (last.price / low - 1) * 100;
  const draw = (high - last.price) / high;
  const buys = win.filter(s => s.side === 'buy').length;
  const sells = win.length - buys;
  const share = buys + sells > 0 ? buys / (buys + sells) : null;
  const volSol = win.reduce((a, s) => a + (s.sol || 0), 0);
  if (
    gain >= cfg.fastPopGainPct &&
    !(cfg.fastPopMaxGainPct > 0 && gain > cfg.fastPopMaxGainPct) &&
    draw <= cfg.fastPopMaxDrop &&
    volSol >= cfg.fastPopMinVolSol &&
    buys >= cfg.fastPopMinBuys &&
    share != null && share >= cfg.fastPopMinBuyShare &&
    !(cfg.fastPopMaxBuyShare > 0 && share >= cfg.fastPopMaxBuyShare)
  ) {
    return {
      setup: 'pop',
      strength: gain,
      metrics: {
        gainPct: +gain.toFixed(1),
        drawFromPeak: +draw.toFixed(3),
        buyRatioM5: +share.toFixed(2),
        volM5: Math.round(volSol), // stream SOL volume in the window (solUsd not known here; bot converts for the journal)
        fastStream: 1,
        windowSec: cfg.fastPopWindowSec,
        trades: win.length,
      },
    };
  }
  return null;
}

// ---- FAST POP FLOORS (user 2026-10-15) ----
// Qualification floors judged in bot._evalFastPop AFTER the detector fires:
// the fire's USD volume figure (metrics.volM5) and the raw burst size
// (metrics.streamVolSol) must each clear a floor, or the burst was dust —
// tonight's fast losers (NEXA $511 / 5 SOL, BISCUIT $1,121 / 11 SOL,
// H2O $1,432 / 14 SOL) all fired on flow the classic pop's volume floor
// would never have let through. Fail-closed: a missing value does not clear
// its floor, and the verdict says so distinctly. Each knob at 0 = floor off.
export function fastPopFloors({ volM5Usd = null, streamVolSol = null } = {}, cfg) {
  const reasons = [];
  let missing = false;
  const usd = (x) => '$' + Math.round(x).toLocaleString('en-US');
  if (cfg.fastPopMinVolM5 > 0) {
    if (volM5Usd == null || !Number.isFinite(volM5Usd)) { missing = true; reasons.push(`5m volume missing — cannot verify the ${usd(cfg.fastPopMinVolM5)} floor`); }
    else if (volM5Usd < cfg.fastPopMinVolM5) reasons.push(`5m volume ${usd(volM5Usd)} under ${usd(cfg.fastPopMinVolM5)} floor`);
  }
  if (cfg.fastPopMinStreamVolSol > 0) {
    if (streamVolSol == null || !Number.isFinite(streamVolSol)) { missing = true; reasons.push(`burst volume missing — cannot verify the ${cfg.fastPopMinStreamVolSol} SOL floor`); }
    else if (streamVolSol < cfg.fastPopMinStreamVolSol) reasons.push(`burst ${streamVolSol} SOL under ${cfg.fastPopMinStreamVolSol} SOL floor`);
  }
  return { pass: reasons.length === 0, missing, reasons };
}
