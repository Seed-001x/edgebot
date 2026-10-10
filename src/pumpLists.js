// pumpLists.js — pulls pump.fun's OWN Trending / Movers / Graduated / New lists (what the app shows).
//
// No dependencies. Fail-open: any error -> [] for that list; never throws.
//
// CONFIG (env, set on your server — never put the token in code or send it to anyone):
//   PUMP_JWT     optional. Bearer token from your logged-in pump.fun session (see README).
//   PUMP_LISTS   optional JSON {"trending":"<url>","movers":"<url>",...}. Overrides the default guesses.
//                Copy the exact URLs from browser DevTools > Network while you click each tab.
//   PUMP_ORIGIN  optional, default https://pump.fun (sent as Origin/Referer).
//
// The DEFAULT urls below are guesses from an unofficial catalog and were NOT verified. Run
// `node pumplists/probe.mjs` on your server first; it prints status + shape for every URL.

const FE = 'https://frontend-api-v3.pump.fun';
export const DEFAULT_LISTS = {
  trending: `${FE}/coins?sort=market_cap&order=DESC&limit=50&offset=0&includeNsfw=false`,
  movers: `${FE}/coins?limit=50&offset=0&sort=last_trade_timestamp&order=DESC&includeNsfw=false&complete=false`,
  graduated: `${FE}/coins?limit=50&offset=0&sort=market_cap&order=DESC&includeNsfw=false&complete=true`,
  new: `${FE}/coins?sort=created_timestamp&order=DESC&limit=50&offset=0&includeNsfw=false`,
};

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const state = {}; // name -> { ok, n, status, ts, err }
export const listState = () => JSON.parse(JSON.stringify(state));

export function resolveLists(env = process.env) {
  if (env.PUMP_LISTS) {
    try { const o = JSON.parse(env.PUMP_LISTS); if (o && typeof o === 'object') return o; } catch { /* fall through */ }
  }
  return DEFAULT_LISTS;
}

/** Extract coin rows from whatever shape the endpoint returns. */
export function normalizeRows(json, source) {
  let arr = Array.isArray(json) ? json : null;
  if (!arr && json && typeof json === 'object') {
    for (const k of ['coins', 'data', 'items', 'results', 'tokens', 'rows']) {
      if (Array.isArray(json[k])) { arr = json[k]; break; }
      if (json[k] && Array.isArray(json[k].coins)) { arr = json[k].coins; break; }
    }
  }
  const out = [];
  const seen = new Set();
  (arr || []).forEach((r0, i) => {
    const r = r0 && (r0.coin || r0.token || r0);
    const mint = r && (r.mint || r.address || r.tokenAddress || r.coinMint || r.id);
    if (typeof mint !== 'string' || !B58.test(mint) || seen.has(mint)) return;
    seen.add(mint);
    out.push({
      address: mint,
      symbol: r.symbol || r.ticker || '???',
      name: r.name || 'Unknown',
      usdMc: Number(r.usd_market_cap ?? r.usdMarketCap ?? r.marketCapUsd ?? r.market_cap_usd ?? r.marketCap) || null,
      complete: r.complete ?? r.graduated ?? null,
      source,
      rank: i + 1,
    });
  });
  return out;
}

export async function fetchPumpList(name, url, { fetchImpl = fetch, env = process.env, timeoutMs = 8000 } = {}) {
  const origin = env.PUMP_ORIGIN || 'https://pump.fun';
  const headers = { accept: 'application/json', origin, referer: origin + '/', 'user-agent': env.PUMP_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' };
  if (env.PUMP_JWT) headers.authorization = `Bearer ${env.PUMP_JWT}`;
  // Optional relay (see relay/worker.js): same request, sent from a different network.
  let target = url;
  if (env.PUMP_RELAY) {
    target = `${env.PUMP_RELAY}${env.PUMP_RELAY.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}`;
    if (env.PUMP_RELAY_KEY) headers['x-relay-key'] = env.PUMP_RELAY_KEY;
  }
  const st = state[name] = { ok: false, n: 0, status: null, ts: Date.now(), err: null, via: env.PUMP_RELAY ? 'relay' : 'direct', server: null, cfRay: null, cfMitigated: null, contentType: null, bodyHead: null };
  try {
    const r = await fetchImpl(target, { headers, signal: AbortSignal.timeout(timeoutMs) });
    st.status = r.status;
    const h = (k) => (r.headers && r.headers.get ? r.headers.get(k) : null);
    st.server = h('server'); st.cfRay = h('cf-ray'); st.cfMitigated = h('cf-mitigated'); st.contentType = h('content-type');
    if (!r.ok) {
      try { st.bodyHead = (await r.text()).replace(/\s+/g, ' ').slice(0, 200); } catch { /* ignore */ }
      st.err = st.cfMitigated ? 'blocked by Cloudflare challenge (IP/bot check)'
        : r.status === 401 ? 'auth: set/refresh PUMP_JWT'
        : r.status === 403 ? 'forbidden: IP/bot block or missing auth (see bodyHead)'
        : r.status === 429 ? 'rate limited' : `http ${r.status}`;
      return [];
    }
    let j;
    try { j = await r.json(); } catch { st.err = 'non-JSON response (HTML challenge page?)'; return []; }
    const rows = normalizeRows(j, 'pump-' + name);
    st.ok = rows.length > 0; st.n = rows.length;
    if (!rows.length) st.err = 'parsed 0 coins (unexpected shape): ' + JSON.stringify(j).slice(0, 160);
    return rows;
  } catch (e) { st.err = String(e && (e.cause && e.cause.code || e.message) || e); return []; }
}

/** All configured lists in parallel -> { trending: rows, movers: rows, ... } */
export async function fetchPumpLists(opts = {}) {
  const env = opts.env || process.env;
  const lists = resolveLists(env);
  const names = Object.keys(lists);
  const res = await Promise.all(names.map(n => fetchPumpList(n, lists[n], opts)));
  return Object.fromEntries(names.map((n, i) => [n, res[i]]));
}
