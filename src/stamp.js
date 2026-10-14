// stamp.js — D1 config version stamp (record-only). A trade's stamp identifies
// the effective strategy config it was entered under, so analysis can split
// trades by config era mechanically: `commit` is the deployed code commit
// (Render sets RENDER_GIT_COMMIT; null outside Render), `cfg` is a short
// digest over every behavior-relevant config field. Two trades share a stamp
// only if they ran under the same code and the same effective knob values.
// Secrets and pure infrastructure (RPC endpoints, API keys, data dir, port)
// are excluded: they don't change strategy behavior, and secrets must never
// leak into journaled records.
import crypto from 'node:crypto';

const EXCLUDE = new Set([
  'modeWarning', 'jupApiKey', 'pumpportalApiKey', 'rpcUrls', 'dataDir', 'port', 'liveFeedUrl',
]);

export function configStamp(cfg) {
  const pairs = [];
  for (const k of Object.keys(cfg || {}).sort()) {
    if (EXCLUDE.has(k)) continue;
    const v = cfg[k];
    if (v === undefined || typeof v === 'function') continue;
    pairs.push([k, v]);
  }
  const digest = crypto.createHash('sha256').update(JSON.stringify(pairs)).digest('hex').slice(0, 10);
  return { commit: process.env.RENDER_GIT_COMMIT || null, cfg: digest };
}
