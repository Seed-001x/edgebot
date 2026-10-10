// server.js — read-only HTTP status. No control endpoints, nothing secret is ever exposed.
// Control is deliberately out-of-band: create a file named HALT in DATA_DIR to stop new entries.

import http from 'node:http';

export function startServer(bot, port) {
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body, null, 2)); };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method !== 'GET') return json(res, 405, { error: 'read-only' });
    if (u.pathname === '/health') return json(res, 200, { ok: true, mode: bot.cfg.realMode ? 'REAL' : 'SHADOW', uptimeSec: Math.round(process.uptime()) });
    if (u.pathname === '/state') return json(res, 200, bot.state());
    if (u.pathname === '/report') return json(res, 200, bot.journal.report());
    if (u.pathname === '/signals') return json(res, 200, bot.journal.recent(Math.min(200, Number(u.searchParams.get('limit')) || 50)));
    if (u.pathname === '/trades') return json(res, 200, bot.journal.trades.slice(-100).reverse());
    return json(res, 404, { error: 'not found', routes: ['/health', '/state', '/report', '/signals', '/trades'] });
  });
  srv.listen(port, () => console.log(`[server] listening on :${port}`));
  return srv;
}
