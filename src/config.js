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
    tradeSol: num(env, 'TRADE_SOL', 0.02),
    maxPositions: num(env, 'MAX_POSITIONS', 5),
    dailyLossSol: num(env, 'DAILY_LOSS_SOL', 0.06),     // realized loss in a UTC day that halts new entries
    killEquityFrac: num(env, 'KILL_EQUITY_FRAC', 0.5),  // wallet SOL below this fraction of starting → permanent halt
    minReserveSol: num(env, 'MIN_RESERVE_SOL', 0.02),   // never spend the last of the fees
    maxTradesPerHour: num(env, 'MAX_TRADES_PER_HOUR', 120),
    mintCooldownMin: num(env, 'MINT_COOLDOWN_MIN', 20),
    maxPoolFraction: num(env, 'MAX_POOL_FRACTION', 0.01), // position ≤ 1% of pool liquidity
    allowLarge: env.ALLOW_LARGE === '1',                // typo guard: TRADE_SOL > 0.25 refused unless set
    shadowStartSol: num(env, 'SHADOW_START_SOL', 1),

    // ---- execution ----
    buyBps: num(env, 'BUY_SLIPPAGE_BPS', 1500),
    sellBps: num(env, 'SELL_SLIPPAGE_BPS', 2500),
    priorityFeeLamports: num(env, 'PRIORITY_FEE_LAMPORTS', 100000),
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

    // ---- 'pop' detector (needs live history: flat → vertical) ----
    popWindowSec: num(env, 'POP_WINDOW_SEC', 300),
    popGainPct: num(env, 'POP_GAIN_PCT', 35),
    popMaxGainPct: num(env, 'POP_MAX_GAIN_PCT', 200),   // already >3x in the window = chasing
    popMinVolH1: num(env, 'POP_MIN_VOL_H1', 10000),
    minBuyRatioM5: num(env, 'MIN_BUY_RATIO_M5', 0.55),
    maxDrawFromPeak: num(env, 'MAX_DRAW_FROM_PEAK', 0.15), // enter on strength, not on the way down

    // ---- 'trend' detector (runner already ranked hot; uses DexScreener priceChange, no history needed) ----
    trendMinH1: num(env, 'TREND_MIN_H1', 25),
    trendMaxH1: num(env, 'TREND_MAX_H1', 400),
    trendMinM5: num(env, 'TREND_MIN_M5', 2),
    trendMinVolH1: num(env, 'TREND_MIN_VOL_H1', 100000),
    trendMinBuyRatio: num(env, 'TREND_MIN_BUY_RATIO', 0.52),

    // ---- gates ----
    requireReportBelowAgeH: num(env, 'REQUIRE_REPORT_BELOW_AGE_H', 6), // young coins with no RugCheck report are blocked
    minHolders: num(env, 'MIN_HOLDERS', 100),
    cloneMinVolMultiple: num(env, 'CLONE_MIN_VOL_MULTIPLE', 2),
    // farm-wallet tiers: balances within FARM_TOL_PCT of each other, in groups of >= FARM_MIN_CLUSTER
    farmTolPct: num(env, 'FARM_TOL_PCT', 0.005),
    farmMinCluster: num(env, 'FARM_MIN_CLUSTER', 3),
    farmMaxWallets: num(env, 'FARM_MAX_WALLETS', 8),
    farmMaxSupplyPct: num(env, 'FARM_MAX_SUPPLY_PCT', 10),
    // dust volume: >= DUST_MIN_TX trades in 1h averaging < DUST_MAX_AVG_USD. Set DUST_MAX_AVG_USD=0 to disable.
    dustMinTx: num(env, 'DUST_MIN_TX', 300),
    dustMaxAvgUsd: num(env, 'DUST_MAX_AVG_USD', 1.5),
    // setup blacklist: 0 = off (per-token blocking only). Set to N to block setups with N+ bad marks.
    setupBlacklistMin: num(env, 'SETUP_BLACKLIST_MIN', 0),

    // ---- exits (judged on REALIZABLE value = Jupiter sell quote, not screen price) ----
    stopLoss: num(env, 'STOP_LOSS', 0.15),
    tp1Pct: num(env, 'TP1_PCT', 0.40),
    tp1Frac: num(env, 'TP1_FRAC', 0.5),
    trailArm: num(env, 'TRAIL_ARM', 0.25),
    trailPct: num(env, 'TRAIL_PCT', 0.15),
    timeStopMin: num(env, 'TIME_STOP_MIN', 25),
    timeStopMinGain: num(env, 'TIME_STOP_MIN_GAIN', 0.10),
    maxHoldMin: num(env, 'MAX_HOLD_MIN', 120),
    momentumFailSellRatio: num(env, 'MOMENTUM_FAIL_SELL_RATIO', 1.8),

    // ---- loops ----
    discoverEverySec: num(env, 'DISCOVER_EVERY_SEC', 20),
    pollEverySec: num(env, 'POLL_EVERY_SEC', 10),
    positionEverySec: num(env, 'POSITION_EVERY_SEC', 8),
    watchMax: num(env, 'WATCH_MAX', 400),
    watchTtlMin: num(env, 'WATCH_TTL_MIN', 20),
    signalCooldownMin: num(env, 'SIGNAL_COOLDOWN_MIN', 10),
    maxSignalsPerTick: num(env, 'MAX_SIGNALS_PER_TICK', 3),

    dataDir: env.DATA_DIR || './data',
    port: num(env, 'PORT', 3000),
  };
  return cfg;
}

export function validateConfig(cfg) {
  const errs = [];
  if (cfg.tradeSol <= 0) errs.push('TRADE_SOL must be > 0');
  if (cfg.tradeSol > 0.25 && !cfg.allowLarge) errs.push(`TRADE_SOL=${cfg.tradeSol} looks like a typo (>0.25). Set ALLOW_LARGE=1 if intentional.`);
  if (cfg.maxPositions < 1 || cfg.maxPositions > 10) errs.push('MAX_POSITIONS must be 1..10');
  if (cfg.dailyLossSol <= 0) errs.push('DAILY_LOSS_SOL must be > 0');
  if (cfg.killEquityFrac <= 0 || cfg.killEquityFrac >= 1) errs.push('KILL_EQUITY_FRAC must be between 0 and 1');
  if (cfg.stopLoss <= 0 || cfg.stopLoss >= 1) errs.push('STOP_LOSS must be between 0 and 1');
  if (cfg.realMode && cfg.rpcUrls.length === 0) errs.push('RPC_URLS required in real mode');
  return errs;
}
