// relayFetch.js — route GeckoTerminal requests through the pump relay when one
// is configured, mirroring the relay pattern in pumpLists.js (relay/worker.js):
// the same request, sent from a different network, because api.geckoterminal.com
// calls made directly from the bot's host fail (the ran-rebuy gate's lookups
// fail open on exactly this — see stats.ranRebuy.lookupFailed).
//
// CONFIG (env, read at call time — the same env pumpLists.js reads):
//   PUMP_RELAY      relay base URL. Unset = direct requests, byte-identical to
//                   the pre-relay behavior (same URL, no extra headers).
//   PUMP_RELAY_KEY  optional shared secret, sent as the x-relay-key header.
//
// Only URLs on the GeckoTerminal host are rewritten; anything else is returned
// untouched, so the helper is safe to apply exactly at the GT call sites.

export const GT_HOST = 'api.geckoterminal.com';

/**
 * Map a full GeckoTerminal URL to the { url, headers } to actually request.
 * Relay unset (or a non-GT / unparseable URL) -> the original URL and no extra
 * headers. Relay set -> `${PUMP_RELAY}[?|&]url=${encodeURIComponent(url)}`,
 * plus the x-relay-key header when PUMP_RELAY_KEY is set.
 */
export function relayRoute(url, env = process.env) {
  if (!env || !env.PUMP_RELAY) return { url, headers: {} };
  let host = null;
  try { host = new URL(url).hostname; } catch { /* unparseable -> direct */ }
  if (host !== GT_HOST) return { url, headers: {} };
  const headers = {};
  if (env.PUMP_RELAY_KEY) headers['x-relay-key'] = env.PUMP_RELAY_KEY;
  return { url: `${env.PUMP_RELAY}${env.PUMP_RELAY.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}`, headers };
}
