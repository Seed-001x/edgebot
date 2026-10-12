// liveFeed.js — real-time new-coin discovery via PumpPortal's websocket.
//
// Why: pump.fun's REST API indexes brand-new coins minutes late (sometimes
// not at all for a while), so API-only discovery is blind to launches in
// their first minutes. PumpPortal streams every new pump.fun launch over
// wss://pumpportal.fun/api/data within seconds of creation.
//
// Fail-open by design: if the socket is down, discovery continues via the
// existing API sources; this module only ADDS mints to the watchlist.
// Auto-reconnects with exponential backoff. Never throws.

import WebSocket from 'ws';

const DEFAULT_URL = 'wss://pumpportal.fun/api/data';
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Extract a new-coin mint from a PumpPortal message. Returns null for anything else. */
export function parseNewCoin(raw) {
  let d;
  try { d = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch { return null; }
  if (!d || typeof d !== 'object') return null;
  if (d.txType !== 'create') return null;
  const mint = d.mint;
  if (typeof mint !== 'string' || !B58.test(mint)) return null;
  return { mint, symbol: d.symbol || null, name: d.name || null };
}

export class LiveFeed {
  /**
   * @param {object} opts
   * @param {string} [opts.url] websocket URL (default PumpPortal)
   * @param {(mint: string) => void} opts.onMint called for every new coin mint
   * @param {(patch: object) => void} [opts.onStats] receives stat updates
   */
  constructor({ url = DEFAULT_URL, onMint, onStats } = {}) {
    this.url = url;
    this.onMint = onMint || (() => {});
    this.onStats = onStats || (() => {});
    this.ws = null;
    this.stopped = false;
    this.backoffMs = 5000;
    this.reconnectTimer = null;
    this.stats = { connected: false, events: 0, added: 0, reconnects: 0, lastEventTs: 0, lastError: null };
  }

  _emitStats() { try { this.onStats({ ...this.stats }); } catch {} }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try { this.ws && this.ws.close(); } catch {}
    this.ws = null;
    this.stats.connected = false;
    this._emitStats();
  }

  _connect() {
    if (this.stopped) return;
    let ws;
    try {
      ws = new WebSocket(this.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EdgebotLiveFeed/1.0)' },
        handshakeTimeout: 15000,
      });
    } catch (e) {
      this.stats.lastError = String(e && e.message || e);
      this._emitStats();
      return this._scheduleReconnect();
    }
    this.ws = ws;

    ws.on('open', () => {
      this.backoffMs = 5000;
      this.stats.connected = true;
      this.stats.lastError = null;
      this._emitStats();
      console.log('[livefeed] connected to', this.url);
      try { ws.send(JSON.stringify({ method: 'subscribeNewToken' })); } catch (e) {
        console.log('[livefeed] subscribe failed:', e.message);
      }
    });

    ws.on('message', (data) => {
      const coin = parseNewCoin(data);
      if (!coin) return;
      this.stats.events++;
      this.stats.lastEventTs = Date.now();
      try {
        if (this.onMint(coin.mint)) this.stats.added++;
      } catch (e) { console.log('[livefeed] onMint failed:', e.message); }
      if (this.stats.events % 10 === 0) this._emitStats();
    });

    ws.on('error', (e) => {
      this.stats.lastError = String(e && e.message || e);
      this._emitStats();
      console.log('[livefeed] error:', this.stats.lastError);
    });

    ws.on('close', () => {
      this.stats.connected = false;
      this._emitStats();
      if (!this.stopped) {
        console.log('[livefeed] disconnected — reconnecting');
        this._scheduleReconnect();
      }
    });
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    this.stats.reconnects++;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 60000);
    this.reconnectTimer = setTimeout(() => this._connect(), wait);
  }
}
