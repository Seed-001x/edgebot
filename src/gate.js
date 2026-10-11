// gate.js — "is this launch rigged / a copy?" gates. Pure functions + one cached RugCheck fetch.
//
// Built from the DOTF / QI pattern we analysed: whole bonding curve bought in one tx, holder count
// inflated with identical-balance wallets, creator stack far larger than pool depth, market cap with no
// relation to the SOL actually in the pool, and a brand-new coin copying the name of an established one.
//
// Policy: any single hard fail blocks entry. A missing RugCheck report blocks young coins (they are
// where rigging lives) and only warns for older, high-volume ones.

import { fetchJson, normName } from './util.js';

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
  return { pass: drain <= maxDrain, reason: drain <= maxDrain ? 'creator stack cannot drain the pool' : `creator holds ${pct != null ? pct.toFixed(1) + '% of supply, ' : ''}could pull ${(drain * 100).toFixed(1)}% of pool SOL` };
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

// 7. Clone check: a younger, smaller coin carrying an established coin's name/ticker.
export function cloneCheck(view, others, cfg) {
  const myName = normName(view.name), mySym = normName(view.symbol);
  for (const o of others || []) {
    if (!o || o.address === view.address) continue;
    const sameName = myName.length >= 4 && normName(o.name) === myName;
    const sameSym = mySym.length >= 3 && normName(o.symbol) === mySym;
    if (!sameName && !sameSym) continue;
    const older = o.createdAt && view.createdAt && o.createdAt <= view.createdAt - 30 * 60 * 1000;
    const bigger = o.volH24 >= view.volH24 * cfg.cloneMinVolMultiple || o.liq >= view.liq * cfg.cloneMinVolMultiple;
    if (older && bigger) return { pass: false, reason: `copies "${o.name}" (${o.address.slice(0, 6)}…) which is older and has ${o.volH24 >= view.volH24 ? 'more volume' : 'more liquidity'}` };
  }
  return { pass: true, reason: 'no established look-alike' };
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
export const HARD_GATES = new Set(['rugged', 'mintAuthority', 'freezeAuthority', 'creator', 'insiders', 'clones', 'farm', 'dust', 'linkedDump']);
/** `fails` are strings like "insiders: 13.1% …". True if ANY failing gate is a hard gate. */
export const hasHardFail = (fails) => (fails || []).some(f => HARD_GATES.has(String(f).split(':')[0]));

/**
 * Run every gate. `rug` may be null. `others` = same-name coins from searchByName.
 * Returns { pass, fails[], warnings[], checks }.
 */
export function runGates({ view, rug, others = [], cfg, now = Date.now() }) {
  const checks = {};
  const warnings = [];
  const ageH = view.createdAt ? (now - view.createdAt) / 3600000 : 0;
  const ageMin = ageH * 60;

  checks.clone = cloneCheck(view, others, cfg);
  checks.vertical = verticalLaunchCheck(ageMin, view.chgH1 ?? view.chgM5 ?? 0);
  checks.dust = dustVolumeCheck(view, { minTx: cfg.dustMinTx, maxAvgUsd: cfg.dustMaxAvgUsd });

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
    checks.creator = creatorDumpCheck({ creatorUi: num(rug.creatorBalance) / 10 ** dec, poolBaseUi: lp.base, poolQuoteUi: lp.quote, supplyUi });
    checks.insiders = insiderCheck(rug.insiderNetworks, supplyRaw);
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
