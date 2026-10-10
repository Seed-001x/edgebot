export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const LAMPORTS = 1e9;

/** GET/POST JSON, fail-open: returns null on any error unless opts.throw. */
export async function fetchJson(url, opts = {}) {
  const { timeout = 8000, headers = {}, method = 'GET', body, throwOnError = false } = opts;
  try {
    const r = await fetch(url, {
      method,
      headers: { accept: 'application/json', 'user-agent': 'edgebot/1.0', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (throwOnError) throw e;
    return null;
  }
}

export const median = (arr) => {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
export const mean = (arr) => {
  const a = arr.filter(Number.isFinite);
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
};
export const round = (v, d = 4) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

export function normName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
}
