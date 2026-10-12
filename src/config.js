// config.js — every number the bot uses lives here. loadConfig(env) is pure so tests can call it.
// All trading thresholds are STARTING GUESSES. The outcome journal exists so you can tune them from data.

const num = (env, k, d) => {
  const v = env[k];
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function loadConfig(env = process.env) {
  const hasKey = !!(env.WALLET_PRIVATE_KEY || '').trim();
  const realMode = env.REAL_MODE === '1' && hasKey;
  const cfg = {
    realMode,
    modeWarning: env.REAL_MODE === '1' && !hasKey ? 'REAL_MODE=1 but WALLET_PRIVATE_KEY missing → running in SHADOW mode' : null,

    // ---- hard limits (enforced in risk.js, not advisory) ----
    tradeSol: num(env, 'TRADE_SOL', 0.05),
    maxPositions: num(env, 'MAX_POSITIONS', 5),
    dailyLossSol: num(env, 'DAILY_LOSS_SOL', 0),        // realized loss in a UTC day that halts new entries; 0 = disabled
    haltAfterCloses: num(env, 'HALT_AFTER_CLOSES', 0),  // one-shot: halt new entries after this many more closes; 0 = off
    killEquityFrac: num(env, 'KILL_EQUITY_FRAC', 0.5),  // wallet SOL below this fraction of starting → permanent halt
    minReserveSol: num(env, 'MIN_RESERVE_SOL', 0.02),   // never spend the last of the fees
    maxTradesPerHour: num(env, 'MAX_TRADES_PER_HOUR', 120),
    mandatoryApesPerHour: num(env, 'MANDATORY_APES_PER_HOUR', 5),
    mintCooldownMin: num(env, 'MINT_COOLDOWN_MIN', 20),
    loserCooldownH: num(env, 'LOSER_COOLDOWN_H', 6),    // don't re-buy a coin that closed at a loss within this many hours (0 = off)
    maxPoolFraction: num(env, 'MAX_POOL_FRACTION', 0.05), // position ≤ 5% of pool liquidity
    allowLarge: env.ALLOW_LARGE === '1',                // typo guard: TRADE_SOL > 0.25 refused unless set
    shadowStartSol: num(env, 'SHADOW_START_SOL', 1),

    // ---- execution ----
    buyBps: num(env, 'BUY_SLIPPAGE_BPS', 1500),
    sellBps: num(env, 'SELL_SLIPPAGE_BPS', 2500),
    priorityFeeLamports: num(env, 'PRIORITY_FEE_LAMPORTS', 100000),
    closeEmptyAccounts: num(env, 'CLOSE_EMPTY_ACCOUNTS', 1) === 1, // after a full sell, close the token account → ~0.002 SOL rent back
    minRoundTrip: num(env, 'MIN_ROUND_TRIP', 0.80),     // sell-back value / spend must be ≥ this, else unexitable/too thin
    jupBase: env.JUP_BASE || 'https://api.jup.ag/swap/v1',
    jupTokensBase: env.JUP_TOKENS_BASE || 'https://lite-api.jup.ag/tokens/v2',
    jupApiKey: env.JUP_API_KEY || '',
    rpcUrls: (env.RPC_URLS || 'https://api.mainnet-beta.solana.com').split(',').map(s => s.trim()).filter(Boolean),

    // ---- eligibility ----
    minMc: num(env, 'MIN_MC', 10000),
    maxMc: num(env, 'MAX_MC', 2_000_000),
    minLiqUsd: num(env, 'MIN_LIQ_USD', 15000),
    minLiqToMc: num(env, 'MIN_LIQ_TO_MC', 0.03),
    minPairAgeMin: num(env, 'MIN_PAIR_AGE_MIN', 0),   // skip pools younger than N min (0 = off). Off: winners W/GTRADE/Playground/19 were all bought 1–5m after pool open

    // ---- 'pop' detector (needs live history: flat → vertical) ----
    popWindowSec: num(env, 'POP_WINDOW_SEC', 300),
    popGainPct: num(env, 'POP_GAIN_PCT', 35),
    popMaxGainPct: num(env, 'POP_MAX_GAIN_PCT', 200),   // already >3x in the window = chasing
    popMinVolH1: num(env, 'POP_MIN_VOL_H1', 20000),   // was 10k (let dead coins in); 50k risked blocking fresh-pool winners
    popMinBuysM5: num(env, 'POP_MIN_BUYS_M5', 20),    // was 5: real momentum = many buyers, not a handful
    popMinChgH1: num(env, 'POP_MIN_CHG_H1', 0),       // coin must be UP on the hour: a bounce off a crash is not a pop
    popMaxBelowHigh: num(env, 'POP_MAX_BELOW_HIGH', 0.30), // skip if price is >30% under its 1h high (dead-cat bounce)
    popMaxDropH6: num(env, 'POP_MAX_DROP_H6', 40),    // skip pops on coins down 40%+ over 6h (for young pools: since launch) — a crash
                                                      // that already left the 1h window still counts (0 = off)
    minBuyRatioM5: num(env, 'MIN_BUY_RATIO_M5', 0.55),
    maxDrawFromPeak: num(env, 'MAX_DRAW_FROM_PEAK', 0.15), // enter on strength, not on the way down

    // ---- 'trend' detector (runner already ranked hot; uses DexScreener priceChange, no history needed) ----
    trendMinH1: num(env, 'TREND_MIN_H1', 25),
    trendMaxH1: num(env, 'TREND_MAX_H1', 400),
    trendMinM5: num(env, 'TREND_MIN_M5', 2),
    trendMinVolH1: num(env, 'TREND_MIN_VOL_H1', 100000),
    trendMinBuyRatio: num(env, 'TREND_MIN_BUY_RATIO', 0.52),
    trendMinBuysM5: num(env, 'TREND_MIN_BUYS_M5', 5),
    // Fresh momentum only: the 5m move must be a real share of the 1h move.
    // A coin up 50% on the hour but only +5% in the last 5m already made its move — that's chasing.
    trendFreshM5Ratio: num(env, 'TREND_FRESH_M5_RATIO', 0.3),
    // Pre-buy freshness guard: abort if the price moved hard between signal and execution (stale quote).
    prebuyMaxDumpPct: num(env, 'PREBUY_MAX_DUMP_PCT', 30), // fresh < signal*(1-30%) → dumped, abort
    prebuyMaxPumpPct: num(env, 'PREBUY_MAX_PUMP_PCT', 100), // fresh > signal*2 → chasing, abort
    // Quote-level freshness guard: price implied by the live round-trip buy quote vs the
    // decision price. The DexScreener re-pull above can lag the pool by minutes (NEVER,
    // 2026-10-12: decided at $49k, filled at $2.3k); the Jupiter quote cannot. 0 = off.
    freshGuardPct: num(env, 'FRESH_GUARD_PCT', 10), // abort if |live − decision| > 10%
    reportEveryTrades: num(env, 'REPORT_EVERY_TRADES', 10), // full report on the dashboard after every N closes

    // ---- gates ----
    requireReportBelowAgeH: num(env, 'REQUIRE_REPORT_BELOW_AGE_H', 6), // young coins with no RugCheck report are blocked
    minHolders: num(env, 'MIN_HOLDERS', 100),
    cloneMinVolMultiple: num(env, 'CLONE_MIN_VOL_MULTIPLE', 2),
    linkedDumpMaxDrain: num(env, 'LINKED_DUMP_MAX_DRAIN', 0.35),
    insiderCountMax: num(env, 'INSIDER_COUNT_MAX', 50),
    minQuoteLiqUsd: num(env, 'MIN_QUOTE_LIQ_USD', 1200),
    ladderMinN: num(env, 'LADDER_MIN_N', 15), ladderMaxRatio: num(env, 'LADDER_MAX_RATIO', 1.6),
    revivalDeadDrop: num(env, 'REVIVAL_DEAD_DROP', 50), revivalBounce: num(env, 'REVIVAL_BOUNCE', 50),
    revivalStrong: num(env, 'REVIVAL_STRONG', 80), revivalSellRatio: num(env, 'REVIVAL_SELL_RATIO', 1.25),
    bundleWatch: num(env, 'BUNDLE_WATCH', 1) === 1,
    bundleCheckSec: num(env, 'BUNDLE_CHECK_SEC', 8),
    bundleWindowSec: num(env, 'BUNDLE_WINDOW_SEC', 120),
    bundleDumpFrac: num(env, 'BUNDLE_DUMP_FRAC', 0.25),
    // farm-wallet tiers: balances within FARM_TOL_PCT of each other, in groups of >= FARM_MIN_CLUSTER
    farmTolPct: num(env, 'FARM_TOL_PCT', 0.005),
    farmMinCluster: num(env, 'FARM_MIN_CLUSTER', 3),
    farmMaxWallets: num(env, 'FARM_MAX_WALLETS', 8),
    farmMaxSupplyPct: num(env, 'FARM_MAX_SUPPLY_PCT', 10),
    // dust volume: >= DUST_MIN_TX trades in 1h averaging < DUST_MAX_AVG_USD. Set DUST_MAX_AVG_USD=0 to disable.
    dustMinTx: num(env, 'DUST_MIN_TX', 300),
    dustMaxAvgUsd: num(env, 'DUST_MAX_AVG_USD', 1.5),
    // instant graduation: bonding curve filled in <= N buys = bought out at launch (0 = off)
    instantGradMaxBuys: num(env, 'INSTANT_GRAD_MAX_BUYS', 3),
    // bot flow: coin younger than BOTFLOW_MAX_AGE_H with >= BOTFLOW_MIN_TX trades in 1h averaging < BOTFLOW_MAX_AVG_USD (0 = off)
    botflowMaxAgeH: num(env, 'BOTFLOW_MAX_AGE_H', 2),
    botflowMinTx: num(env, 'BOTFLOW_MIN_TX', 1000),
    botflowMaxAvgUsd: num(env, 'BOTFLOW_MAX_AVG_USD', 6),
    // setup blacklist: 0 = off (per-token blocking only). Set to N to block setups with N+ bad marks.
    setupBlacklistMin: num(env, 'SETUP_BLACKLIST_MIN', 0),

    // ---- exits (judged on REALIZABLE value = Jupiter sell quote, not screen price) ----
    stopLoss: num(env, 'STOP_LOSS', 0.15),                // backstop on realizable value (incl. fees/slippage)
    dipStopPct: num(env, 'DIP_STOP_PCT', 0.05),           // sell if PRICE drops this far below entry (0 = off)
    stallSec: num(env, 'STALL_SEC', 60),                  // sell if price sits near/below entry this long (0 = off)
    stallBandPct: num(env, 'STALL_BAND_PCT', 0.02),       // "near entry" = below entry +2%; climbing past it resets the clock
    tp1Pct: num(env, 'TP1_PCT', 0.25),                    // bank part on the jump: +25% in your pocket after slippage + SOL fees
    tp1Frac: num(env, 'TP1_FRAC', 0.65),                  // ...sell 65% of it
    tpTrailPct: num(env, 'TP_TRAIL_PCT', 0.25),           // after TP1, trail the rest this far below its peak (hard floor at entry)
    lockArm: num(env, 'PROFIT_LOCK_ARM', 0.15),           // once up +15% or more after fees...
    lockKeep: num(env, 'PROFIT_LOCK_KEEP', 0.5),          // ...sell the rest if it falls below half of its best gain (0 = off)
    trailArm: num(env, 'TRAIL_ARM', 1.00),
    trailPct: num(env, 'TRAIL_PCT', 0.25),
    timeStopMin: num(env, 'TIME_STOP_MIN', 25),
    timeStopMinGain: num(env, 'TIME_STOP_MIN_GAIN', 0.10),
    maxHoldMin: num(env, 'MAX_HOLD_MIN', 120),
    momentumFailSellRatio: num(env, 'MOMENTUM_FAIL_SELL_RATIO', 1.8),

    // ---- loops ----
    discoverEverySec: num(env, 'DISCOVER_EVERY_SEC', 20),
    pollEverySec: num(env, 'POLL_EVERY_SEC', 10),
    positionEverySec: num(env, 'POSITION_EVERY_SEC', 4),
    watchMax: num(env, 'WATCH_MAX', 400),
    watchTtlMin: num(env, 'WATCH_TTL_MIN', 20),
    signalCooldownMin: num(env, 'SIGNAL_COOLDOWN_MIN', 10),
    maxSignalsPerTick: num(env, 'MAX_SIGNALS_PER_TICK', 3),

    // ---- live feed (PumpPortal websocket: new launches in seconds) ----
    liveFeed: env.LIVE_FEED !== '0',
    liveFeedUrl: env.PUMPPORTAL_WS_URL || 'wss://pumpportal.fun/api/data',

    dataDir: env.DATA_DIR || './data',
    port: num(env, 'PORT', 3000),
  };
  cfg.txFeeSol = (5000 + cfg.priorityFeeLamports) / 1e9; // SOL network cost of one swap transaction
  return cfg;
}

export function validateConfig(cfg) {
  const errs = [];
  if (cfg.tradeSol <= 0) errs.push('TRADE_SOL must be > 0');
  if (cfg.tradeSol > 0.25 && !cfg.allowLarge) errs.push(`TRADE_SOL=${cfg.tradeSol} looks like a typo (>0.25). Set ALLOW_LARGE=1 if intentional.`);
  if (cfg.maxPositions < 1 || cfg.maxPositions > 10) errs.push('MAX_POSITIONS must be 1..10');
  if (cfg.dailyLossSol < 0) errs.push('DAILY_LOSS_SOL must be >= 0 (0 = disabled)');
  if (cfg.haltAfterCloses < 0) errs.push('HALT_AFTER_CLOSES must be >= 0');
  if (cfg.killEquityFrac <= 0 || cfg.killEquityFrac >= 1) errs.push('KILL_EQUITY_FRAC must be between 0 and 1');
  if (cfg.stopLoss <= 0 || cfg.stopLoss >= 1) errs.push('STOP_LOSS must be between 0 and 1');
  if (cfg.dipStopPct < 0 || cfg.dipStopPct >= 1) errs.push('DIP_STOP_PCT must be between 0 and 1 (0 = off)');
  if (cfg.stallSec < 0) errs.push('STALL_SEC must be >= 0 (0 = off)');
  if (cfg.lockKeep < 0 || cfg.lockKeep >= 1) errs.push('PROFIT_LOCK_KEEP must be between 0 and 1 (0 = off)');
  if (cfg.tp1Frac < 0 || cfg.tp1Frac > 1) errs.push('TP1_FRAC must be between 0 and 1');
  if (cfg.tpTrailPct < 0 || cfg.tpTrailPct >= 1) errs.push('TP_TRAIL_PCT must be between 0 and 1');
  if (cfg.stallBandPct < 0) errs.push('STALL_BAND_PCT must be >= 0');
  if (cfg.realMode && cfg.rpcUrls.length === 0) errs.push('RPC_URLS required in real mode');
  return errs;
}
