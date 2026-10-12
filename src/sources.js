// sources.js — discovery + live data. Every call is fail-open (returns [] / null).
//
// Discovery is QUOTA-based: each source gets its own slice of the watchlist so a noisy source
// (new launches) can never crowd out the others (volume-ranked trending, movers, graduated runners).
// This is the fix for the old bot's addrs.slice(0,120) problem.

import { fetchJson, SOL_MINT } from './util.js';

const DS = 'https://api.dexscreener.com';
const GT = 'https://api.geckoterminal.com/api/v2';
const PF = 'https://frontend-api-v3.pump.fun';

// ------------------------------------------------------------------ DexScreener
export function viewOf(pair) {
  if (!pair || !pair.baseToken || !pair.baseToken.address) return null;
  const price = Number(pair.priceUsd) || null;
  const fdv = Number(pair.fdv) || null;
  const mc = Number(pair.marketCap) || fdv;
  const tx = pair.txns || {};
  const vol = pair.volume || {};
  const pc = pair.priceChange || {};
  return {
    address: pair.baseToken.address,
    symbol: pair.baseToken.symbol || '???',
    name: pair.baseToken.name || 'Unknown',
    price, mc: mc || null,
    liq: Number(pair.liquidity && pair.liquidity.usd) || 0,
    volM5: Number(vol.m5) || 0, volH1: Number(vol.h1) || 0, volH6: Number(vol.h6) || 0, volH24: Number(vol.h24) || 0,
    buysM5: Number(tx.m5 && tx.m5.buys) || 0, sellsM5: Number(tx.m5 && tx.m5.sells) || 0,
    buysH1: Number(tx.h1 && tx.h1.buys) || 0, sellsH1: Number(tx.h1 && tx.h1.sells) || 0,
    chgM5: pc.m5 != null ? Number(pc.m5) : null, chgH1: pc.h1 != null ? Number(pc.h1) : null,
    chgH6: pc.h6 != null ? Number(pc.h6) : null, chgH24: pc.h24 != null ? Number(pc.h24) : null,
    createdAt: Number(pair.pairCreatedAt) || null,
    dex: pair.dexId || null, pairAddress: pair.pairAddress || null, quote: pair.quoteToken && pair.quoteToken.symbol,
  };
}

/** Latest view per mint (best-liquidity pair). Chunks of 30. */
export async function fetchViews(mints) {
  const uniq = [...new Set(mints)].filter(Boolean);
  const best = new Map();
  for (let i = 0; i < uniq.length; i += 30) {
    const chunk = uniq.slice(i, i + 30);
    const pairs = await fetchJson(`${DS}/tokens/v1/solana/${chunk.join(',')}`);
    for (const p of pairs || []) {
      const v = viewOf(p);
      if (!v) continue;
      const cur = best.get(v.address);
      if (!cur || v.liq > cur.liq) best.set(v.address, v);
    }
  }
  return best;
}

let solCache = { ts: 0, price: 150 };
export async function fetchSolUsd(now = Date.now()) {
  if (now - solCache.ts < 60000) return solCache.price;
  const pairs = await fetchJson(`${DS}/tokens/v1/solana/${SOL_MINT}`);
  const p = Number(pairs && pairs[0] && pairs[0].priceUsd);
  if (p > 0) solCache = { ts: now, price: p };
  return solCache.price;
}

/**
 * Trade counts on the coin's pump.fun bonding-curve pair (for the instant-graduation gate).
 * Returns { buys, sells } from the last 24h, or null if the coin has no curve pair / data is missing.
 */
export async function fetchCurve(mint) {
  const pairs = await fetchJson(`${DS}/token-pairs/v1/solana/${mint}`);
  const curve = (Array.isArray(pairs) ? pairs : []).find(p => p && p.dexId === 'pumpfun');
  if (!curve) return null;
  const graduated = pairs.some(p => p && p.dexId && p.dexId !== 'pumpfun');
  if (!graduated) return null; // still on the curve — nothing to judge yet
  const h24 = (curve.txns && curve.txns.h24) || {};
  return { buys: Number(h24.buys) || 0, sells: Number(h24.sells) || 0 };
}

/** Same-name / same-ticker coins, for the clone check. */
export async function searchByName(query) {
  const j = await fetchJson(`${DS}/latest/dex/search?q=${encodeURIComponent(query)}`);
  const out = new Map();
  for (const p of (j && j.pairs) || []) {
    if (p.chainId !== 'solana') continue;
    const v = viewOf(p);
    if (!v) continue;
    const cur = out.get(v.address);
    if (!cur || v.liq > cur.liq) out.set(v.address, v);
  }
  return [...out.values()];
}

// ------------------------------------------------------------------ discovery lists
async function jupList(cfg, path) {
  const headers = cfg.jupApiKey ? { 'x-api-key': cfg.jupApiKey } : {};
  const j = await fetchJson(`${cfg.jupTokensBase}/${path}`, { headers });
  const arr = Array.isArray(j) ? j : (j && (j.data || j.tokens)) || [];
  return arr.map(t => t && (t.id || t.address || t.mint)).filter(x => typeof x === 'string');
}

async function pumpMovers(limit = 50) {
  const j = await fetchJson(`${PF}/coins?offset=0&limit=${limit}&sort=last_trade_timestamp&order=DESC&includeNsfw=false`);
  return (Array.isArray(j) ? j : []).filter(c => c && c.mint && !c.is_banned).map(c => c.mint);
}

async function gtPools(path) {
  const j = await fetchJson(`${GT}/${path}`);
  const out = [];
  for (const p of (j && j.data) || []) {
    const id = p.relationships && p.relationships.base_token && p.relationships.base_token.data && p.relationships.base_token.data.id;
    if (id && id.startsWith('solana_')) out.push(id.slice(7));
  }
  return out;
}

async function dsBoosts() {
  const j = await fetchJson(`${DS}/token-boosts/top/v1`);
  return (Array.isArray(j) ? j : []).filter(t => t.chainId === 'solana' && t.tokenAddress).map(t => t.tokenAddress);
}

/**
 * Returns Map(mint -> source). Quotas keep every source represented.
 * NOTE: the Jupiter token-list and GeckoTerminal sort params were written from documentation and
 * could not be verified from the build sandbox; each is fail-open and /state shows per-source counts
 * so you can see immediately if one returns nothing.
 */
export async function discover(cfg) {
  // Import pump.fun lists (the exact lists the user sees on pump.fun)
  const { fetchPumpLists } = await import('./pumpLists.js');
  const [jupTrend, jupTraded, movers, boosts, pumpLists] = await Promise.all([
    jupList(cfg, 'toptrending/1h?limit=150'),
    jupList(cfg, 'toptraded/1h?limit=150'),
    pumpMovers(80),
    dsBoosts(),
    fetchPumpLists().catch(() => ({})),
  ]);
  // Extract mints from pump.fun lists
  const pfTrending = (pumpLists.trending || []).map(c => c.address);
  const pfMovers = (pumpLists.movers || []).map(c => c.address);
  const pfGraduated = (pumpLists.graduated || []).map(c => c.address);
  const pfNew = (pumpLists.new || []).map(c => c.address);
  // Note: GeckoTerminal sources removed 2026-10-10 — API fails silently from Render.
  const plan = [
    ['pump-trending', pfTrending, 60], ['pump-movers', pfMovers, 60],
    ['pump-graduated', pfGraduated, 40], ['pump-new', pfNew, 40],
    ['jup-trending', jupTrend, 80], ['jup-traded', jupTraded, 60], ['pump-movers-api', movers, 40],
    ['boosts', boosts, 20],
  ];
  const out = new Map();
  const counts = {};
  for (const [name, list, quota] of plan) {
    let taken = 0;
    for (const m of list) {
      if (taken >= quota) break;
      if (m === SOL_MINT) continue;
      if (!out.has(m)) { out.set(m, name); taken++; }
    }
    counts[name] = { returned: list.length, taken };
  }
  out.counts = counts;
  return out;
}
