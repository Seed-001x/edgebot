import { loadConfig, validateConfig } from './config.js';
import { Executor } from './exec.js';
import { Bot } from './bot.js';
import { startServer } from './server.js';
import { discover, fetchViews, fetchSolUsd, searchByName } from './sources.js';
import { fetchRug } from './gate.js';

const cfg = loadConfig();
const errs = validateConfig(cfg);
if (errs.length) { console.error('Config errors:\n - ' + errs.join('\n - ')); process.exit(1); }

const exec = new Executor(cfg);
const bot = new Bot(cfg, { discover, fetchViews, fetchSolUsd, fetchRug, searchByName, exec });

console.log(`[edgebot] mode=${cfg.realMode ? 'REAL' : 'SHADOW'}${cfg.modeWarning ? '  (' + cfg.modeWarning + ')' : ''}`);
console.log(`[edgebot] limits: ${cfg.tradeSol} SOL/trade, ${cfg.maxPositions} positions, daily loss cap ${cfg.dailyLossSol} SOL, kill at <${cfg.killEquityFrac * 100}% equity`);

const boot = await bot.start();
console.log(`[edgebot] wallet ${cfg.realMode ? await exec.address() : '(shadow)'} balance ${boot.solBalance} SOL, ${boot.openPositions} open positions restored`);
startServer(bot, cfg.port);

const every = (sec, fn) => { fn(); return setInterval(fn, sec * 1000); };
every(cfg.discoverEverySec, () => bot.discoverTick());
every(cfg.pollEverySec, () => bot.pollTick());
every(cfg.positionEverySec, () => bot.positionTick());
every(60, () => bot.reconcilePositions());

process.on('unhandledRejection', (e) => console.error('[edgebot] unhandledRejection', e && e.message));
process.on('SIGTERM', () => { console.log('[edgebot] SIGTERM — positions are persisted; exiting'); process.exit(0); });
