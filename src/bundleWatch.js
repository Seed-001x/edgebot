// bundleWatch.js — in-position "bundle exit risk" score (0-100). Pure functions, no I/O.
//
// Idea: bundles don't dump from nowhere. The holders that matter (largest non-pool token accounts at entry) are
// snapshotted every few seconds while we hold. The score ramps with COORDINATION, not with a single sale:
//   one wallet trimming is normal profit-taking (low score); two or three wallets selling inside the same window,
//   supply leaving them, price/pool reacting, or tokens being moved into fresh wallets (re-hiding stock before a
//   dump) push the score up. The bot trims at `half` and leaves at `all`.
//
// snapshots = [{ ts, amts: { [tokenAccount]: rawAmountNumber } }, ...] oldest -> newest (newest = now)
// tracked   = array of token-account addresses to judge (top non-pool accounts at entry)

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function bundleRisk({ snapshots, tracked, supply, priceDropPct = 0, weights = {}, windowSec = 120, dumpFrac = 0.25, now }, ) {
  const none = { score: 0, dumpers: 0, soldSupplyPct: 0, shuffles: 0, parts: {}, reason: null };
  if (!snapshots || snapshots.length < 2 || !tracked || !tracked.length) return none;
  const cur = snapshots[snapshots.length - 1];
  const t = now != null ? now : cur.ts;
  const inWin = snapshots.filter(s => s.ts >= t - windowSec * 1000);
  const ref = (inWin.length >= 2 ? inWin[0] : snapshots[Math.max(0, snapshots.length - 2)]);
  if (ref === cur) return none;

  const trackedSet = new Set(tracked);
  const dumpedAmts = [];
  let soldRaw = 0, dumpers = 0, dumperW = 0;
  for (const a of tracked) {
    const r = num(ref.amts[a]); if (r <= 0) continue;
    const c = num(cur.amts[a]);                      // missing from the top list = fell out = (nearly) emptied
    const drop = (r - c) / r;
    if (drop >= dumpFrac) { dumpers++; dumperW += weights[a] || 1; soldRaw += r - c; dumpedAmts.push({ amt: r - c, emptied: c <= r * 0.1 }); }
  }
  const soldSupplyPct = supply > 0 ? (soldRaw / supply) * 100 : 0;

  // tokens that left a wallet and reappeared as a NEW top holder of about the same size = moved to an associated wallet
  const fresh = Object.entries(cur.amts).filter(([a]) => !trackedSet.has(a) && !(a in ref.amts)).map(([, v]) => num(v));
  const used = new Set(); let shuffles = 0;
  for (const d of dumpedAmts) {
    if (!d.emptied) continue;
    const i = fresh.findIndex((f, k) => !used.has(k) && Math.abs(f - d.amt) / d.amt <= 0.08);
    if (i >= 0) { used.add(i); shuffles++; }
  }

  const w = Math.round(dumperW);   // creator / linked wallets count double: a dev sell is worth two ordinary holders
  const coord = w >= 4 ? 75 : w === 3 ? 65 : w === 2 ? 40 : w === 1 ? 10 : 0;
  const supplyPart = Math.min(25, soldSupplyPct * 10);
  const impact = dumpers >= 1 ? (priceDropPct >= 25 ? 25 : priceDropPct >= 10 ? 15 : 0) : 0;
  const shufflePart = Math.min(40, shuffles * 20);
  const score = Math.min(100, Math.round(coord + supplyPart + impact + shufflePart));
  const bits = [];
  if (dumpers) bits.push(`${dumpers} tracked wallet${dumpers > 1 ? 's' : ''} sold ≥${Math.round(dumpFrac * 100)}%`);
  if (soldSupplyPct >= 0.1) bits.push(`${soldSupplyPct.toFixed(2)}% of supply`);
  if (impact) bits.push(`price −${priceDropPct.toFixed(0)}%`);
  if (shuffles) bits.push(`${shuffles} transfer(s) to fresh wallets`);
  return { score, dumpers, soldSupplyPct: +soldSupplyPct.toFixed(3), shuffles, parts: { coord, supplyPart: +supplyPart.toFixed(1), impact, shufflePart }, reason: bits.join(', ') || null };
}

// score -> action. `trimmed` stops the half-sell from repeating every tick.
export function bundleDecision(r, cfg, trimmed = false) {
  if (!r || !(r.score > 0)) return { fraction: 0 };
  if (r.score >= cfg.bundleSellAll) return { fraction: 1, reason: `bundle exit risk ${r.score}/100 (${r.reason})` };
  if (r.score >= cfg.bundleSellHalf && !trimmed) return { fraction: 0.5, trim: true, reason: `bundle exit risk ${r.score}/100 — trimming (${r.reason})` };
  return { fraction: 0 };
}

// choose which accounts to watch: top non-pool token accounts from the RugCheck report at entry
export function pickTracked(rug, n = 20) {
  if (!rug || !Array.isArray(rug.topHolders)) return null;
  const skip = new Set();
  for (const [addr, info] of Object.entries(rug.knownAccounts || {})) if (info && (info.type === 'AMM' || info.type === 'LOCKER')) skip.add(addr);
  for (const m of rug.markets || []) if (m && m.pubkey) skip.add(m.pubkey);
  const out = rug.topHolders.filter(h => h && h.address && !skip.has(h.owner) && !skip.has(h.address)).slice(0, n).map(h => h.address);
  return out.length ? out : null;
}

// accounts that are LINKED to the creator/insiders (RugCheck flags them) get double weight; the creator wallet itself is tracked
// under the synthetic key CREATOR_KEY (its balance is read by owner, since it need not be a top-20 account).
export const CREATOR_KEY = 'CREATOR';
export function linkedWeights(rug) {
  const w = {};
  if (rug && Array.isArray(rug.topHolders)) for (const h of rug.topHolders) if (h && h.address && h.insider) w[h.address] = 2;
  w[CREATOR_KEY] = 2;
  return w;
}
