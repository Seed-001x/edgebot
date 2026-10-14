// gate.js — "is this launch rigged / a copy?" gates. Pure functions + one cached RugCheck fetch.
//
// Built from the DOTF / QI pattern we analysed: whole bonding curve bought in one tx, holder count
// inflated with identical-balance wallets, creator stack far larger than pool depth, market cap with no
// relation to the SOL actually in the pool, and a brand-new coin copying the name of an established one.
//
// Policy: any single hard fail blocks entry. A missing RugCheck report blocks young coins (they are
// where rigging lives) and only warns for older, high-volume ones.

import { fetchJson } from './util.js';

const RC = 'https://api.rugcheck.xyz/v1';
const cache = new Map(); // mint -> { ts, report }
const TTL = 120000;

export async function fetchRug(mint, now = Date.now()) {
  const c = cache.get(mint);
  if (c && now - c.ts < TTL) return c.report;
  const report = await fetchJson(`${RC}/tokens/${mint}/report`, { timeout: 10000 });
  cache.set(mint, { ts: now, report });
  return report;
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function poolOwnerSet(rug) {
  const s = new Set();
  for (const [addr, info] of Object.entries(rug.knownAccounts || {})) {
    if (info && (info.type === 'AMM' || info.type === 'LOCKER')) s.add(addr);
  }
  for (const m of rug.markets || []) { if (m && m.pubkey) s.add(m.pubkey); }
  return s;
}

// 1. Identical-balance holders: organic buyers never end up with the exact same token amount.
export function cloneHolderCheck(topHolders, skip, minCluster = 6) {
  const buckets = new Map();
  for (const h of topHolders || []) {
    if (!h || skip.has(h.owner) || skip.has(h.address)) continue;
    const amt = num(h.amount);
    if (amt > 0) buckets.set(amt, (buckets.get(amt) || 0) + 1);
  }
  const worst = Math.max(0, ...buckets.values());
  return { pass: worst < minCluster, reason: worst >= minCluster ? `${worst} wallets hold the exact same balance (one funder)` : 'balances distinct' };
}

// 1b. Near-identical balances in tiers (farm wallets): scripted buys with slightly different amounts after fees/rounding.
//     Exact-match (above) misses these. Sort holder balances and group those within `tol` (relative) of the tier's largest;
//     fail on many wallets in tiers of >= minCluster, or a large share of supply sitting in such tiers.
export function farmTiersCheck(topHolders, skip, { tol = 0.005, minCluster = 3, maxWallets = 8, maxSupplyPct = 10 } = {}) {
  const hs = (topHolders || []).filter(h => h && !skip.has(h.owner) && !skip.has(h.address) && num(h.amount) > 0)
    .map(h => ({ amt: num(h.amount), pct: num(h.pct) })).sort((a, b) => b.amt - a.amt);
  const clusters = [];
  let cur = [];
  for (const h of hs) {
    if (cur.length && (cur[0].amt - h.amt) / cur[0].amt <= tol) cur.push(h);
    else { if (cur.length >= minCluster) clusters.push(cur); cur = [h]; }
  }
  if (cur.length >= minCluster) clusters.push(cur);
  const wallets = clusters.reduce((a, c) => a + c.length, 0);
  const pct = clusters.reduce((a, c) => a + c.reduce((x, h) => x + h.pct, 0), 0);
  const bad = wallets >= maxWallets || pct >= maxSupplyPct;
  return { pass: !bad, reason: bad ? `${wallets} wallets in ${clusters.length} near-identical-balance tiers hold ${pct.toFixed(1)}% of supply (farm wallets)` : 'no farm tiers', wallets, tiers: clusters.length, pct };
}

// 1c. Dust volume: huge transaction count but tiny average trade = scripted spam / wash, not people.
export function dustVolumeCheck(view, { minTx = 300, maxAvgUsd = 1.5 } = {}) {
  const tx = (view.buysH1 || 0) + (view.sellsH1 || 0);
  if (!(maxAvgUsd > 0) || tx < minTx) return { pass: true, reason: 'enough real size or too few trades to judge' };
  const avg = (view.volH1 || 0) / tx;
  return { pass: avg >= maxAvgUsd, reason: avg >= maxAvgUsd ? 'avg trade size ok' : `${tx} trades in 1h averaging $${avg.toFixed(2)} (scripted dust, not buyers)`, avgUsd: avg };
}

// 1d. Instant graduation: the whole pump.fun bonding curve filled in a handful of buys.
//     A real launch has hundreds of buyers before it graduates; ≤3 buys means one party bought ~80% of
//     supply at launch, then spreads it across farm wallets and walks the price up (the "YouTube" pattern).
//     `curve` = { buys, sells } on the coin's pump.fun bonding-curve pair, or null if unknown.
//     Unknown never blocks (fail-open), so a data hiccup can't stop good entries.
export function instantGradCheck(curve, ageH, { maxBuys = 3, maxAgeH = 24 } = {}) {
  if (!curve || !(maxBuys > 0)) return { pass: true, reason: 'curve history unknown' };
  if (ageH > maxAgeH) return { pass: true, reason: 'too old to judge from 24h data' };
  const buys = num(curve.buys);
  if (buys <= 0) return { pass: true, reason: 'curve history unknown' };
  const bundled = num(curve.buyIxs) > buys ? ` (${num(curve.buyIxs)} buys bundled into them)` : '';
  return { pass: buys > maxBuys, reason: buys > maxBuys ? `${buys} buys on the curve` : `bonding curve filled in ${buys} buy tx(s)${bundled} — bought out at launch`, buys };
}

// 1e. Bot flow on a young coin: thousands of trades averaging a few dollars = volume bots walking
//     the price up (smooth staircase chart), not people. Wider than `dust` but limited to young coins,
//     where this pattern lives; older runners with lots of small retail trades are not touched.
export function botFlowCheck(view, ageH, { maxAgeH = 2, minTx = 1000, maxAvgUsd = 6 } = {}) {
  const tx = (view.buysH1 || 0) + (view.sellsH1 || 0);
  if (!(maxAvgUsd > 0) || ageH > maxAgeH || tx < minTx) return { pass: true, reason: 'not a young high-churn coin' };
  const avg = (view.volH1 || 0) / tx;
  return { pass: avg >= maxAvgUsd, reason: avg >= maxAvgUsd ? 'avg trade size ok' : `${tx} trades in 1h averaging $${avg.toFixed(2)} on a ${Math.round(ageH * 60)}m-old coin (volume bots)`, avgUsd: avg };
}

// 2. Pool depth vs market cap.
export function exitDepthCheck(liqUsd, mc, minRatio) {
  if (!(mc > 0)) return { pass: false, reason: 'no market cap' };
  const ratio = num(liqUsd) / mc;
  return { pass: ratio >= minRatio, reason: ratio >= minRatio ? 'pool depth ok' : `pool is ${(ratio * 100).toFixed(2)}% of market cap — cap is not exit value` };
}

// 3. Creator dump: constant-product sim of the creator selling their whole stack into the pool.
export function creatorDumpCheck({ creatorUi, poolBaseUi, poolQuoteUi, supplyUi }, maxDrain = 0.25) {
  const x = num(creatorUi);
  if (!(x > 0)) return { pass: true, reason: 'creator holds nothing' };
  const B = num(poolBaseUi), Q = num(poolQuoteUi);
  if (!(B > 0) || !(Q > 0)) return { pass: false, reason: 'creator holds tokens and pool data is missing' };
  const drain = x / (B + x);
  const pct = supplyUi > 0 ? (x / supplyUi) * 100 : null;
  return { pass: drain <= maxDrain, drain, pct, reason: drain <= maxDrain ? 'creator stack cannot drain the pool' : `creator holds ${pct != null ? pct.toFixed(1) + '% of supply, ' : ''}could pull ${(drain * 100).toFixed(1)}% of pool SOL` };
}

// 4. Linked-wallet networks.
export function insiderCheck(networks, supplyRaw, maxPct = 10) {
  const held = (networks || []).reduce((a, n) => a + num(n.currentHolding), 0);
  const pct = supplyRaw > 0 ? (held / supplyRaw) * 100 : 0;
  return { pass: pct <= maxPct, reason: pct > maxPct ? `${pct.toFixed(1)}% of supply in linked wallets` : 'no large linked network' };
}

// 5. Vertical launch: a huge move on a coin minutes old is the pool being pushed, not demand.
export function verticalLaunchCheck(ageMin, chgPct, maxPct = 5000, maxAgeMin = 120) {
  const bad = ageMin <= maxAgeMin && num(chgPct) >= maxPct;
  return { pass: !bad, reason: bad ? `+${Math.round(chgPct).toLocaleString()}% in ${Math.round(ageMin)}m` : 'move not vertical' };
}

// 6. Concentration of non-pool top-10 holders.
export function concentrationCheck(topHolders, skip, maxPct = 60) {
  const real = (topHolders || []).filter(h => h && !skip.has(h.owner) && !skip.has(h.address)).slice(0, 10);
  const pct = real.reduce((a, h) => a + num(h.pct), 0);
  return { pass: pct <= maxPct, reason: pct > maxPct ? `top-10 non-pool holders own ${pct.toFixed(0)}%` : 'distribution ok' };
}

// 7b. Name block: whole-word match against the token's name ("Crypto Inu", "Super Crypto Inu").
//     Whole words only, so names that merely contain the letters ("Continuum", "Minute") still pass.
export function blockedNameWord(name, words) {
  if (!name || !words || !words.length) return null;
  const parts = String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of words) {
    const word = String(w || '').toLowerCase();
    if (word && parts.includes(word)) return word;
  }
  return null;
}

// 7d. Extension above the breakout base (user 2026-10-13): how far the current price sits
//     above the lowest price sampled in the trailing hour — the base the move launched from.
//     An entry at extreme extension (OTTO: bought the top of a long range after a +162%/5m
//     print, stopped 23s later by the range's own chop) has a full retracement to the base
//     waiting under it — the same wobble that means nothing at the base is a stop-out at the
//     top. Judged on the bot's OWN samples; too little history = no base to judge = pass.
export function extensionCheck(samples, price, now, { maxExt = 1.5, windowMin = 60, minSamples = 10, minSpanSec = 180 } = {}) {
  if (!(maxExt > 0) || !(price > 0)) return { pass: true, reason: 'extension check off' };
  const win = (samples || []).filter(s => s && s.price > 0 && now - s.ts <= windowMin * 60000);
  if (win.length < minSamples) return { pass: true, reason: 'too few samples to judge the base' };
  const tsList = win.map(s => s.ts);
  const spanSec = (Math.max(...tsList) - Math.min(...tsList)) / 1000;
  if (spanSec < minSpanSec) return { pass: true, reason: 'sample span too short to judge the base' };
  const base = Math.min(...win.map(s => s.price));
  if (!(base > 0)) return { pass: true, reason: 'no base price in samples' };
  const ext = price / base - 1;
  const over = ext > maxExt;
  return {
    pass: !over, ext, base,
    reason: over
      ? `extended: price is +${Math.round(ext * 100)}% above the trailing ${windowMin}m base (cap +${Math.round(maxExt * 100)}%)`
      : `extension +${Math.round(ext * 100)}% above the trailing ${windowMin}m base — within the cap`,
  };
}

// 7f. Shallow dip under the recent top (user 2026-10-14): a classic entry may be taken at
//     the trailing window's sampled top, breaking above it, or on a REAL dip (maxPct or
//     more under the top — deep dips included) — but NOT a few percent under the top
//     (his example: -5%), which is the rollover spot: the top just failed and the entry
//     catches the first leg down. Deep dips pass THIS check untouched; each setup's own
//     volume / buy-inflow legs still judge them. This replaces the stale-pop veto
//     (removed earlier today, 2026-10-14, CODE): no age/distance path may veto a signal
//     maxPct+ under its sampled top anymore. Judged on the bot's OWN samples; too little
//     history = no real top to judge = pass.
export function shallowDipCheck(samples, price, now, { maxPct = 0.10, windowMin = 60, minSamples = 3, minSpanSec = 60 } = {}) {
  if (!(maxPct > 0) || !(price > 0)) return { pass: true, reason: 'shallow-dip check off' };
  const win = (samples || []).filter(s => s && s.price > 0 && now - s.ts <= windowMin * 60000);
  if (win.length < minSamples) return { pass: true, reason: 'too few samples to judge the top' };
  const tsList = win.map(s => s.ts);
  const spanSec = (Math.max(...tsList) - Math.min(...tsList)) / 1000;
  if (spanSec < minSpanSec) return { pass: true, reason: 'sample span too short to judge the top' };
  const top = Math.max(...win.map(s => s.price));
  if (!(top > 0)) return { pass: true, reason: 'no top price in samples' };
  const dist = (top - price) / top;
  const inZone = dist > 0 && dist < maxPct;
  return {
    pass: !inZone, dist, top,
    reason: inZone
      ? `-${(dist * 100).toFixed(1)}% under the trailing ${windowMin}m top — the rollover zone (0 to ${Math.round(maxPct * 100)}% under); buy the top, a new high, or a real dip`
      : dist <= 0
        ? 'at or above the recent top — no shallow dip'
        : `-${(dist * 100).toFixed(1)}% under the trailing ${windowMin}m top — a real dip, judged by the setup's demand legs`,
  };
}

// 7e. Fresh-history fail-closed (user 2026-10-13, entry-fixes A3): coins discovered mid-run
//     from the trending/movers lists arrive with little or no sampled history, and the
//     sample-judged guard above (extension) fails OPEN on thin data — it waved
//     BORING through (+41.6% in 5m against +13.8% on the hour at a $14.5k cap, a 3-hour-old
//     corpse mid-bounce). When there isn't enough history to judge, DexScreener's own
//     aggregates decide instead: a 5-minute move that has ALREADY printed beyond the cap is
//     a chase, and a small cap whose entire hourly move is one 5-minute candle is a blip.
//     With enough samples this check passes untouched — the sampled guard does the judging.
export function freshHistoryCheck(samples, view, now, { maxChgM5 = 25, smallMc = 30000, m5ShareH1 = 0.7, windowMin = 60, minSamples = 10, minSpanSec = 180 } = {}) {
  if (!(maxChgM5 > 0) && !(m5ShareH1 > 0)) return { pass: true, reason: 'fresh check off' };
  const win = (samples || []).filter(s => s && s.price > 0 && now - s.ts <= windowMin * 60000);
  if (win.length >= minSamples) {
    const tsList = win.map(s => s.ts);
    if ((Math.max(...tsList) - Math.min(...tsList)) / 1000 >= minSpanSec) {
      return { pass: true, judged: true, reason: 'enough sampled history — sampled guards judge this one' };
    }
  }
  const chgM5 = view ? view.chgM5 : null;
  const chgH1 = view ? view.chgH1 : null;
  const mc = view ? view.mc : null;
  if (maxChgM5 > 0 && chgM5 != null && chgM5 > maxChgM5) {
    return { pass: false, reason: `fresh coin, no sampled history, and already +${Math.round(chgM5)}% in 5m (cap +${Math.round(maxChgM5)}%) — the move already happened` };
  }
  if (m5ShareH1 > 0 && mc != null && mc < smallMc && chgM5 != null && chgH1 != null && chgH1 > 0 && chgM5 >= m5ShareH1 * chgH1) {
    return { pass: false, reason: `fresh small cap ($${Math.round(mc)}): the whole hourly move (+${Math.round(chgH1)}%) is one 5m candle (+${Math.round(chgM5)}%) — a blip, not a trend` };
  }
  return { pass: true, judged: false, reason: 'thin history, but aggregates are not extended' };
}

// One-go dump simulation: ALL linked supply (creator + linked networks) sold into the pool at once.
// drain = share of the pool's SOL they could pull.
export function linkedDumpCheck({ creatorUi, networks, dec, poolBaseUi, poolQuoteUi }, maxDrain = 0.35) {
  const netUi = (networks || []).reduce((a, n) => a + num(n.currentHolding), 0) / 10 ** dec;
  const x = num(creatorUi) + netUi;
  if (!(x > 0)) return { pass: true, reason: 'no linked stack' };
  const B = num(poolBaseUi), Q = num(poolQuoteUi);
  if (!(B > 0) || !(Q > 0)) return { pass: true, unknown: true, reason: 'pool data missing' };
  const drain = x / (B + x);
  return { pass: drain <= maxDrain, drain, reason: drain <= maxDrain ? `linked stack could pull ${(drain * 100).toFixed(0)}% of pool SOL` : `linked wallets could dump in one go and pull ${(drain * 100).toFixed(0)}% of pool SOL` };
}





/** Gates that no feedback, "contested" count or pace keeper may override. They describe how the coin is built, not how it looks. */
export const HARD_GATES = new Set(['rugged', 'mintAuthority', 'freezeAuthority', 'creator', 'insiders', 'clones', 'farm', 'dust', 'linkedDump', 'instantGrad', 'botflow']);
/** `fails` are strings like "insiders: 13.1% …". True if ANY failing gate is a hard gate. */
export const hasHardFail = (fails) => (fails || []).some(f => HARD_GATES.has(String(f).split(':')[0]));

/**
 * Run every gate. `rug` may be null.
 * Returns { pass, fails[], warnings[], checks }.
 */
export function runGates({ view, rug, curve = null, cfg, now = Date.now() }) {
  const checks = {};
  const warnings = [];
  const ageH = view.createdAt ? (now - view.createdAt) / 3600000 : 0;
  const ageMin = ageH * 60;

  checks.vertical = verticalLaunchCheck(ageMin, view.chgH1 ?? view.chgM5 ?? 0);
  checks.dust = dustVolumeCheck(view, { minTx: cfg.dustMinTx, maxAvgUsd: cfg.dustMaxAvgUsd });
  checks.botflow = botFlowCheck(view, ageH, { maxAgeH: cfg.botflowMaxAgeH ?? 2, minTx: cfg.botflowMinTx ?? 1000, maxAvgUsd: cfg.botflowMaxAvgUsd ?? 6 });
  checks.instantGrad = instantGradCheck(curve, ageH, { maxBuys: cfg.instantGradMaxBuys ?? 3 });

  if (!rug) {
    if (ageH < cfg.requireReportBelowAgeH) checks.report = { pass: false, reason: 'no RugCheck report for a young coin' };
    else warnings.push('no RugCheck report (older coin — allowed)');
  } else {
    const dec = num(rug.token && rug.token.decimals, 6);
    const supplyRaw = num(rug.token && rug.token.supply);
    const supplyUi = supplyRaw / 10 ** dec;
    const skip = poolOwnerSet(rug);
    const markets = (rug.markets || []).filter(m => m && m.lp);
    const top = markets.sort((a, b) => num(b.lp.lpLockedUSD) - num(a.lp.lpLockedUSD))[0];
    const lp = (top && top.lp) || {};

    if (rug.rugged === true) checks.rugged = { pass: false, reason: 'RugCheck flags RUGGED' };
    const mintAuth = rug.token && rug.token.mintAuthority, freezeAuth = rug.token && rug.token.freezeAuthority;
    if (mintAuth) checks.mintAuthority = { pass: false, reason: 'mint authority is open (dev can print tokens)' };
    if (freezeAuth) checks.freezeAuthority = { pass: false, reason: 'freeze authority is open (dev can freeze your tokens)' };

    checks.clones = cloneHolderCheck(rug.topHolders, skip);
    checks.farm = farmTiersCheck(rug.topHolders, skip, { tol: cfg.farmTolPct, minCluster: cfg.farmMinCluster, maxWallets: cfg.farmMaxWallets, maxSupplyPct: cfg.farmMaxSupplyPct });
    checks.creator = creatorDumpCheck({ creatorUi: num(rug.creatorBalance) / 10 ** dec, poolBaseUi: lp.base, poolQuoteUi: lp.quote, supplyUi }, cfg.creatorMaxDrain ?? 0.25);
    // Creator-veto volume bypass (user 2026-10-14, Eikon): the veto exists because the dev can
    // dump their stack — but when 5m volume is deep, real flow is already absorbing sells, and
    // the veto only delayed entry into the top (Eikon: skipped at $53K with $39.1K of 5m volume,
    // bought later at $307K, lost). Above CREATOR_VOL_BYPASS_USD the holdings veto becomes a
    // warning; the stack stays visible on the signal record. Only the computed-drain fail can be
    // bypassed — a missing-pool-data fail still blocks (we could not judge the stack at all).
    const creatorBypassUsd = cfg.creatorVolBypassUsd ?? 25000;
    if (!checks.creator.pass && checks.creator.drain != null && creatorBypassUsd > 0 && num(view.volM5) >= creatorBypassUsd) {
      const volTxt = Math.round(num(view.volM5)).toLocaleString('en-US');
      const barTxt = Number(creatorBypassUsd).toLocaleString('en-US');
      warnings.push(`creator: holds ${checks.creator.pct != null ? checks.creator.pct.toFixed(1) + '%' : 'a large stack'} — veto bypassed by 5m volume $${volTxt} (>= $${barTxt})`);
      checks.creator = { ...checks.creator, pass: true, bypassed: true };
    }
    checks.insiders = insiderCheck(rug.insiderNetworks, supplyRaw, cfg.insiderMaxPct);
    checks.linkedDump = linkedDumpCheck({ creatorUi: num(rug.creatorBalance) / 10 ** dec, networks: rug.insiderNetworks, dec, poolBaseUi: lp.base, poolQuoteUi: lp.quote }, cfg.linkedDumpMaxDrain);
    checks.concentration = concentrationCheck(rug.topHolders, skip);
    if (lp.lpLockedPct != null && num(lp.lpLockedPct) < 80) checks.lp = { pass: false, reason: `LP only ${num(lp.lpLockedPct)}% locked/burned — dev can pull` };
    else if (lp.lpLockedPct == null) warnings.push('LP lock unknown');
    const holders = rug.totalHolders;
    if (holders != null && ageH < cfg.requireReportBelowAgeH && holders < (cfg.minHolders ?? 100)) checks.holders = { pass: false, reason: `only ${holders} holders` };
  }

  checks.depth = exitDepthCheck(view.liq, view.mc, cfg.minLiqToMc);
  const fails = Object.entries(checks).filter(([, c]) => !c.pass).map(([k, c]) => `${k}: ${c.reason}`);
  return { pass: fails.length === 0, fails, warnings, checks };
}

/**
 * One-trade temporary rules, set by the user for the NEXT executed entry only
 * (bot clears them the moment a buy lands). Pure check over the signal view:
 *   maxMc       — refuse coins above this market cap
 *   maxDropPct  — refuse coins down this much (from the 1h high, or over 6h)
 * Returns a skip reason string, or null when the coin is allowed.
 */
export function tempRuleViolation(v, metrics, rules) {
  if (!rules || !v) return null;
  if (rules.maxMc > 0 && v.mc != null && v.mc > rules.maxMc) {
    return `temp: market cap $${Math.round(v.mc).toLocaleString('en-US')} over one-trade cap $${Number(rules.maxMc).toLocaleString('en-US')}`;
  }
  if (rules.maxDropPct > 0) {
    const dd = metrics && metrics.drawFromPeak; // 0..1 below the recent high
    if (dd != null && dd >= rules.maxDropPct / 100) return `temp: down ${(dd * 100).toFixed(0)}% from its high — one-trade crash ban (${rules.maxDropPct}%)`;
    if (v.chgH6 != null && v.chgH6 <= -rules.maxDropPct) return `temp: down ${Math.abs(v.chgH6).toFixed(0)}% over 6h — one-trade crash ban (${rules.maxDropPct}%)`;
  }
  return null;
}
