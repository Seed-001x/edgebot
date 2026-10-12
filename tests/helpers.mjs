import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

export const tmp = () => fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'edgebot-'));
export const testCfg = (over = {}, env = {}) => ({ ...loadConfig({ DATA_DIR: tmp(), ...env }), ...over });

export const view = (o = {}) => ({
  address: 'MINT1', symbol: 'TEST', name: 'Test Coin', price: 1, mc: 1_000_000, liq: 100_000,
  volM5: 50_000, volH1: 50_000, volH6: 100_000, volH24: 200_000,
  buysM5: 30, sellsM5: 10, buysH1: 200, sellsH1: 100,
  chgM5: 1, chgH1: 5, chgH6: 10, chgH24: 20, createdAt: Date.now() - 10 * 3600e3, dex: 'pumpswap', ...o,
});

export const sample = (ts, price, extra = {}) => ({ ts, price, mc: price * 1e6, volM5: 0, volH1: 0, buysM5: 0, sellsM5: 0, liq: 100_000, ...extra });
