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
      draw <= cfg.maxDrawFromPeak && notBouncing &&
      v.volM5 >= cfg.popMinVolM5 &&
      v.buysM5 >= cfg.popMinBuysM5 &&
      ratio5 != null && ratio5 >= cfg.minBuyRatioM5
    ) {
      return { setup: 'pop', strength: gain, metrics: { gainPct: +gain.toFixed(1), drawFromPeak: +draw.toFixed(3), buyRatioM5: +ratio5.toFixed(2), volH1: v.volH1, volM5: v.volM5 } };
    }
  }

  // ---- TREND ----
  // Fresh momentum only: most of the hourly move must be happening NOW (chgM5 a real share of chgH1),
  // not a spike from 40 minutes ago that's just drifting at the top.
  if (
    v.chgH1 != null && v.chgM5 != null &&
    v.chgH1 >= cfg.trendMinH1 && v.chgH1 <= cfg.trendMaxH1 &&
    v.chgM5 >= cfg.trendMinM5 &&
    v.chgM5 >= v.chgH1 * cfg.trendFreshM5Ratio &&
    v.volH1 >= cfg.trendMinVolH1 &&
    v.buysM5 >= cfg.trendMinBuysM5 &&
    ratio5 != null && ratio5 >= cfg.trendMinBuyRatio
  ) {
    // don't buy a coin that already rolled over from a recent high
    const recent = (samples || []).filter(s => now - s.ts <= 15 * 60 * 1000);
    const high = recent.length ? Math.max(...recent.map(s => s.price)) : v.price;
    if (v.price >= high * 0.85) {
      return { setup: 'trend', strength: v.chgH1 / 10, metrics: { chgH1: v.chgH1, chgM5: v.chgM5, buyRatioM5: +ratio5.toFixed(2), volH1: v.volH1 } };
    }
  }
  return null;
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
    draw <= cfg.fastPopMaxDrop &&
    volSol >= cfg.fastPopMinVolSol &&
    buys >= cfg.fastPopMinBuys &&
    share != null && share >= cfg.fastPopMinBuyShare
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
