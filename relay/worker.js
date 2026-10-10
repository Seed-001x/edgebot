// Cloudflare Worker relay (free tier). Deploy at dash.cloudflare.com > Workers > Create, paste this, set secret RELAY_KEY.
// Then on Render: PUMP_RELAY=https://<your-worker>.workers.dev/  PUMP_RELAY_KEY=<same secret>
// It forwards ONLY pump.fun API hosts and passes your Authorization header through.
// UNTESTED against pump.fun: Workers egress from Cloudflare's network, which is often (not always) treated more kindly than cloud-host IPs.
const ALLOW = ['frontend-api-v3.pump.fun', 'advanced-api-v2.pump.fun', 'market-api.pump.fun', 'volatility-api-v2.pump.fun'];
export default {
  async fetch(req, env) {
    if (!env.RELAY_KEY || req.headers.get('x-relay-key') !== env.RELAY_KEY) return new Response('no', { status: 401 });
    const target = new URL(req.url).searchParams.get('url');
    let u; try { u = new URL(target); } catch { return new Response('bad url', { status: 400 }); }
    if (u.protocol !== 'https:' || !ALLOW.includes(u.hostname)) return new Response('host not allowed', { status: 403 });
    const h = new Headers();
    for (const k of ['accept', 'authorization', 'origin', 'referer', 'user-agent']) if (req.headers.get(k)) h.set(k, req.headers.get(k));
    return fetch(u.toString(), { headers: h });
  },
};
