// server.js — read-only HTTP status. No control endpoints, nothing secret is ever exposed.
// Control is deliberately out-of-band: create a file named HALT in DATA_DIR to stop new entries.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { listState } from './pumpLists.js';
import { EXIT_REASONS, learnReport } from './learn.js';

// Browser-scraped "real" pump.fun lists (from hourly browser task, not the API relay).
// Stored in DATA_DIR so it persists across deploys.
const DATA_DIR = process.env.DATA_DIR || './data';
const REAL_LISTS_FILE = path.join(DATA_DIR, 'reallists.json');
let realLists = { trending: [], movers: [], ts: 0 };
try {
  const raw = fs.readFileSync(REAL_LISTS_FILE, 'utf8');
  realLists = JSON.parse(raw);
} catch {}
function saveRealLists() {
  try { fs.writeFileSync(REAL_LISTS_FILE, JSON.stringify(realLists)); } catch {}
}

export function startServer(bot, port) {
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body, null, 2)); };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      res.end();
      return;
    }
    // POST /feedback — human marks a skipped signal as good/bad
    if (req.method === 'POST' && u.pathname === '/feedback') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
      req.on('end', () => {
        try {
          const { mint, symbol, good, signalId } = JSON.parse(body);
          if (!mint) return json(res, 400, { error: 'mint required' });
          const rec = bot.journal.recordFeedback({ mint, symbol, good, signalId });
          return json(res, 200, { ok: true, feedback: rec });
        } catch (e) {
          return json(res, 400, { error: 'invalid JSON' });
        }
      });
      return;
    }
    // POST /feedback/clear — wipe all human feedback (fresh start)
    if (req.method === 'POST' && u.pathname === '/feedback/clear') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1000) req.destroy(); });
      req.on('end', () => {
        try {
          const n = bot.journal.clearFeedback();
          return json(res, 200, { ok: true, cleared: n });
        } catch (e) {
          return json(res, 500, { error: e.message });
        }
      });
      return;
    }
    // POST /exittag {id, reason} — label WHY you closed a position yourself (label only; cannot trade)
    if (req.method === 'POST' && u.pathname === '/exittag') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 5000) req.destroy(); });
      req.on('end', () => {
        try {
          const { id, reason } = JSON.parse(body);
          if (!EXIT_REASONS.includes(reason)) return json(res, 400, { error: 'reason must be one of ' + EXIT_REASONS.join(', ') });
          const m = bot.journal.tagExit(id, reason);
          return m ? json(res, 200, { ok: true, exit: m }) : json(res, 404, { error: 'no such manual exit' });
        } catch { return json(res, 400, { error: 'invalid JSON' }); }
      });
      return;
    }
    // POST /manualexit {id} — SHADOW mode only: "I'd have closed this one". Needs header x-learn-key == LEARN_KEY.
    if (req.method === 'POST' && u.pathname === '/manualexit') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 5000) req.destroy(); });
      req.on('end', async () => {
        const key = process.env.LEARN_KEY;
        if (bot.cfg.realMode) return json(res, 400, { error: 'real mode: just sell in your wallet — the bot detects it' });
        if (!key || req.headers['x-learn-key'] !== key) return json(res, 401, { error: 'bad or missing key' });
        try { const { id } = JSON.parse(body); const r = await bot.markManualExit(id); return r ? json(res, 200, { ok: true, exit: r }) : json(res, 404, { error: 'no such open position' }); }
        catch { return json(res, 400, { error: 'invalid JSON' }); }
      });
      return;
    }
    // GET /learn — recent manual exits + comparison with bot winners
    if (req.method === 'GET' && u.pathname === '/learn') {
      const report = learnReport(bot.journal.manual, bot.journal.trades);
      const exits = bot.journal.manual.slice(-20).reverse().map(m => ({ id: m.id, symbol: m.symbol, mint: m.mint, ts: m.ts, heldMin: m.heldMin, peakRatio: m.peakRatio, pnlSolEstimate: m.pnlSolEstimate, reason: m.reason || null, how: m.how }));
      report.exits = exits;
      report.recent = exits; // dashboard expects `recent`
      report.report = report; // dashboard expects nested report
      return json(res, 200, report);
    }
    // POST /reallists — browser task pushes scraped pump.fun lists (trending/movers/graduated/new, 50 each)
    if (req.method === 'POST' && u.pathname === '/reallists') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1000000) req.destroy(); });
      req.on('end', () => {
        try {
          const { trending, movers, graduated, new: newCoins } = JSON.parse(body);
          if (!Array.isArray(trending) || !Array.isArray(movers)) return json(res, 400, { error: 'trending and movers arrays required' });
          realLists = {
            trending: trending.slice(0, 50),
            movers: movers.slice(0, 50),
            graduated: Array.isArray(graduated) ? graduated.slice(0, 50) : [],
            new: Array.isArray(newCoins) ? newCoins.slice(0, 50) : [],
            ts: Date.now()
          };
          saveRealLists();
          return json(res, 200, { ok: true, trending: realLists.trending.length, movers: realLists.movers.length, graduated: realLists.graduated.length, new: realLists.new.length, ts: realLists.ts });
        } catch (e) {
          return json(res, 400, { error: 'invalid JSON' });
        }
      });
      return;
    }
    if (req.method === 'DELETE' && u.pathname.startsWith('/positions/')) {
      const id = decodeURIComponent(u.pathname.slice(11));
      const n = bot.positions.length;
      bot.positions = bot.positions.filter(x => x.id !== id && x.mint !== id);
      bot.savePositions();
      return json(res, 200, { ok: true, removed: n - bot.positions.length });
    }
    if (req.method === 'POST' && u.pathname === '/positions/clear') {
      const n = bot.positions.length;
      bot.positions = [];
      bot.savePositions();
      return json(res, 200, { ok: true, cleared: n });
    }
    if (req.method === 'POST' && u.pathname === '/risk/reset') {
      bot.risk.s.dayPnlSol = 0;
      bot.risk.s.day = new Date().toISOString().slice(0, 10);
      bot.risk.save();
      return json(res, 200, { ok: true, dayPnlSol: 0 });
    }
    if (req.method === 'GET' && u.pathname === '/watchlist') {
      const out = [];
      for (const [mint, w] of bot.watch) {
        const v = bot.latest.get(mint);
        out.push({
          mint,
          symbol: v?.symbol || '?',
          name: v?.name || '',
          mc: v?.mc || null,
          source: w.source || '?',
        });
      }
      return json(res, 200, { count: out.length, coins: out });
    }
    if (req.method === 'GET' && u.pathname === '/reallists') {
      return json(res, 200, {
        trending: { n: realLists.trending.length, rows: realLists.trending, ts: realLists.ts },
        movers: { n: realLists.movers.length, rows: realLists.movers, ts: realLists.ts },
        graduated: { n: (realLists.graduated || []).length, rows: realLists.graduated || [], ts: realLists.ts },
        new: { n: (realLists.new || []).length, rows: realLists.new || [], ts: realLists.ts },
      });
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'read-only' });
    if (u.pathname === '/health') {
      const h = { ok: true, mode: bot.cfg.realMode ? 'REAL' : 'SHADOW', uptimeSec: Math.round(process.uptime()) };
      if (bot.lastCallout) h.lastCallout = bot.lastCallout;
      return json(res, 200, h);
    }
    if (u.pathname === '/state') return json(res, 200, bot.state());
    if (u.pathname === '/pumplists') return json(res, 200, listState());
    if (u.pathname === '/report') return json(res, 200, bot.journal.report());
    if (u.pathname === '/signals') return json(res, 200, bot.journal.recent(Math.min(200, Number(u.searchParams.get('limit')) || 50)));
    if (u.pathname === '/trades') return json(res, 200, bot.journal.trades.slice(-100).reverse());
    return json(res, 404, { error: 'not found', routes: ['/health', '/state', '/pumplists', '/report', '/signals', '/trades'] });
  });
  srv.listen(port, () => console.log(`[server] listening on :${port}`));
  return srv;
}
