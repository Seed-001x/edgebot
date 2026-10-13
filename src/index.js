import { loadConfig, validateConfig } from './config.js';
import { Executor } from './exec.js';
import { Bot } from './bot.js';
import { startServer } from './server.js';
import { discover, fetchViews, fetchSolUsd, searchByName, fetchCurve } from './sources.js';
import { fetchRug } from './gate.js';

const cfg = loadConfig();
const errs = validateConfig(cfg);
if (errs.length) { console.error('Config errors:\n - ' + errs.join('\n - ')); process.exit(1); }

const exec = new Executor(cfg);
const bot = new Bot(cfg, { discover, fetchViews, fetchSolUsd, fetchRug, searchByName, fetchCurve: (mint) => fetchCurve(mint, cfg), exec });

console.log(`[edgebot] mode=${cfg.realMode ? 'REAL' : 'SHADOW'}${cfg.modeWarning ? '  (' + cfg.modeWarning + ')' : ''}`);
console.log(`[edgebot] limits: ${cfg.tradeSol} SOL/trade, ${cfg.maxPositions} positions, daily loss cap ${cfg.dailyLossSol} SOL, kill at <${cfg.killEquityFrac * 100}% equity`);

const boot = await bot.start();
console.log(`[edgebot] wallet ${cfg.realMode ? await exec.address() : '(shadow)'} balance ${boot.solBalance} SOL, ${boot.openPositions} open positions restored`);
startServer(bot, cfg.port);

// Live new-coin feed (PumpPortal websocket): brand-new launches land in the
// watchlist within seconds, long before the REST APIs index them. Fail-open.
if (cfg.liveFeed) {
  const { LiveFeed } = await import('./liveFeed.js');
  const feed = new LiveFeed({
    url: cfg.liveFeedUrl,
    onMint: (mint) => bot.noteMint(mint, 'live-ws'),
    onStats: (s) => { bot.stats.liveFeed = s; },
  });
  feed.start();
  process.on('SIGTERM', () => feed.stop());
}

const every = (sec, fn) => { fn(); return setInterval(fn, sec * 1000); };
every(cfg.discoverEverySec, () => bot.discoverTick());
every(cfg.pollEverySec, () => bot.pollTick());
every(cfg.positionEverySec, () => bot.positionTick());
every(60, () => bot.reconcilePositions());

process.on('unhandledRejection', (e) => console.error('[edgebot] unhandledRejection', e && e.message));
process.on('SIGTERM', () => { console.log('[edgebot] SIGTERM — positions are persisted; exiting'); process.exit(0); });
