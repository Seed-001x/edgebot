// gradWatch.js — graduation watch (user 2026-10-14: "do that every 2 minutes then not 3hrs").
//
// Post-graduation runners were structurally invisible to this bot: Plois graduated
// 2026-10-14T05:18:08Z and immediately ran +41% in 5m (406 buys / 258 sells) while the
// bot had never seen the mint — the /reallists graduated list arrives EMPTY (mirror
// gap) and the movers/trending scrape that feeds discovery is 3-hourly. Nothing in
// the bot noticed the graduation moment itself.
//
// This poller asks pump.fun's own frontend-api-v3 for recently COMPLETED coins every
// GRAD_POLL_SEC, freshest trade activity first, and feeds fresh graduations into the
// watchlist through Bot.noteMint under the source name 'graduated' — noteMint's
// reserved-slice rule gives them their own 25% slice of WATCH_MAX with oldest-first
// rotation, exactly like the live feed, so a burst of graduations can never crowd
// out curated sources (and is itself capped).
//
// There is NO graduation timestamp in the v3 payload (fields: created_timestamp,
// last_trade_timestamp, complete, pump_swap_pool, …), and created_timestamp alone
// cannot judge freshness — Plois sat on the curve 49 minutes before graduating, so a
// "created within 30m" gate would have missed the founding case. The reliable signal
// is the TRANSITION: a mint this poller observes as complete for the first time,
// while it is actively trading (last trade inside GRAD_FRESH_MIN), graduated recently
// as far as anyone can observe — or is heating up post-graduation, which is the same
// runner class this watch exists for.
//
// Boot backfill (user 2026-10-14: "Add the boot backfill"): priming used to absorb
// EVERYTHING currently complete as seen-only history (flowWatch's watermark rule),
// so a coin that graduated while the bot was down was gone for good — UNTXED
// graduated 01:28 EDT, this watcher booted 01:39, and the coin stayed invisible
// until DexScreener gainers discovery happened to rotate it in ~20 minutes later.
// The priming poll now applies the SAME freshness gate as normal adds: completions
// still trading inside GRAD_FRESH_MIN are backfilled through onAdd, capped at
// GRAD_BACKFILL_MAX freshest-first; everything else is still absorbed as seen-only
// history. GRAD_BACKFILL_MAX=0 restores the old pure priming.
//
// Fail-open throughout: a failed poll logs and retries next cycle, never throws.

import { fetchJson } from './util.js';
import { relayRoutePump } from './relayFetch.js';

const PF = 'https://frontend-api-v3.pump.fun';
// Recently completed coins, freshest trade activity first. Verified live
// 2026-10-14: complete=true is honored, sort is honored, limit=100 returns
// ~70 actively-trading graduated coins (every row's last trade < 1m old at
// probe time) — a fresh graduation that trades at all lands at the top.
export const GRAD_QUERY = `${PF}/coins?offset=0&limit=100&sort=last_trade_timestamp&order=DESC&includeNsfw=false&complete=true`;

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Same browser-style headers pumpLists.js sends (the API rate-limits plain agents).
const PF_HEADERS = {
  origin: 'https://pump.fun', referer: 'https://pump.fun/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

async function fetchGradRows() {
  // Via the pump relay when configured (2026-10-16 fix): direct calls to the
  // v3 API are Cloudflare-403'd from the bot's host — every poll failed and
  // the graduation feed sat dark while the relay-routed lists worked.
  const { url, headers } = relayRoutePump(GRAD_QUERY);
  const j = await fetchJson(url, { headers: { ...PF_HEADERS, ...headers }, timeout: 10000, throwOnError: true });
  return Array.isArray(j) ? j : [];
}

/**
 * Pure: which mints in a v3 coins payload are FRESH graduations worth adding.
 * A mint qualifies when ALL hold:
 *   - the row says complete === true and the coin is not banned
 *   - the mint is not in `seenComplete` (first observed completion — the transition)
 *   - it is actively trading: last_trade_timestamp inside GRAD_FRESH_MIN of `now`
 *     (falls back to created_timestamp when no trade stamp exists)
 * `seenComplete` is read-only here; the caller absorbs yielded mints into it.
 */
export function freshGraduations(rows, cfg, now = Date.now(), seenComplete = new Set()) {
  const freshMs = (cfg.gradFreshMin ?? 30) * 60000;
  const out = [];
  const yielded = new Set();
  for (const c of rows || []) {
    if (!c || c.complete !== true || c.is_banned) continue;
    const mint = c.mint;
    if (typeof mint !== 'string' || !B58.test(mint)) continue;
    if (seenComplete.has(mint) || yielded.has(mint)) continue;
    const stamp = Number(c.last_trade_timestamp) || Number(c.created_timestamp) || 0;
    if (!stamp || now - stamp > freshMs) continue; // stale completion — dead or long-graduated
    yielded.add(mint);
    out.push(mint);
  }
  return out;
}

export class GradWatch {
  /**
   * deps: { cfg, onAdd(mint) -> bool, onStats(stats), now, fetchRows, log }
   * onAdd is Bot.noteMint — the reserved-slice watchlist intake.
   */
  constructor({ cfg, onAdd, onStats = null, now = Date.now, fetchRows = null, log = console.log }) {
    this.cfg = cfg;
    this.onAdd = onAdd || (() => false);
    this.onStats = onStats;
    this.now = now;
    this.log = log;
    this.fetchRows = fetchRows || fetchGradRows;
    this.seenComplete = new Set(); // mints already observed complete (primed or yielded)
    this.primed = false;
    this.timer = null;
    this.polling = false;
    this.stats = { polls: 0, added: 0, backfilled: 0, lastPollTs: 0, lastError: null };
  }

  get active() { return !!this.cfg.gradWatchEnabled; }

  emitStats() { if (this.onStats) this.onStats({ ...this.stats }); }

  start() {
    if (!this.active || this.timer) return;
    // Poll immediately at boot so the backfill lands at startup and the first
    // transition adds come one cycle in, not two; the interval keeps the cadence.
    this.poll().catch(e => this.log(`[gradwatch] poll failed: ${e && e.message}`));
    this.timer = setInterval(() => { this.poll().catch(e => this.log(`[gradwatch] poll failed: ${e && e.message}`)); }, this.cfg.gradPollSec * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  async poll() {
    if (this.polling || !this.active) return;
    this.polling = true;
    try {
      const rows = await this.fetchRows();
      if (!Array.isArray(rows)) throw new Error('graduation payload was not an array');
      const n = this.now();
      this.stats.polls++; this.stats.lastPollTs = n; this.stats.lastError = null;
      if (!this.primed) {
        // Boot backfill: everything currently complete is absorbed into the seen
        // set (those graduations predate this process), but the ones passing the
        // SAME freshness gate as normal adds are also ADDED through onAdd —
        // capped at GRAD_BACKFILL_MAX, freshest first (the payload is sorted by
        // last trade DESC and freshGraduations preserves that order). Mints
        // beyond the cap, and stale completions, are seen-only history, exactly
        // as pure priming behaved. Cap 0 = no backfill (pure priming).
        const cap = this.cfg.gradBackfillMax ?? 50;
        const backfillSet = new Set(cap > 0 ? freshGraduations(rows, this.cfg, n, new Set()).slice(0, cap) : []);
        for (const c of rows) {
          if (!c || c.complete !== true || typeof c.mint !== 'string') continue;
          this.seenComplete.add(c.mint);
          if (!backfillSet.has(c.mint)) continue;
          let added = false;
          try { added = !!this.onAdd(c.mint); } catch { added = false; }
          if (added) { this.stats.added++; this.stats.backfilled++; this.log(`[gradwatch] boot backfill → watchlist: ${c.mint}`); }
        }
        this.primed = true;
        this.emitStats();
        return;
      }
      const fresh = freshGraduations(rows, this.cfg, n, this.seenComplete);
      for (const mint of fresh) {
        this.seenComplete.add(mint); // yielded once — never re-added by this poller
        let added = false;
        try { added = !!this.onAdd(mint); } catch { added = false; }
        if (added) { this.stats.added++; this.log(`[gradwatch] fresh graduation → watchlist: ${mint}`); }
      }
      // Bound the seen set (insertion-ordered): graduations are one-way, so
      // forgetting the oldest sightings can at worst re-add a live old coin once.
      if (this.seenComplete.size > 5000) this.seenComplete = new Set([...this.seenComplete].slice(-3000));
      this.emitStats();
    } catch (e) {
      this.stats.lastError = String(e && e.message || e);
      this.emitStats();
    } finally { this.polling = false; }
  }
}
