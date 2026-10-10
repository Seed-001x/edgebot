// callout.js — posts pump.fun callouts when the bot enters a position.
//
// Flow:
//   1. Auth: sign "Sign in to pump.fun: <ts>" with the wallet key → POST /auth/login → JWT
//   2. Thesis: generate a punchy thesis from the entry signal (setup, metrics, MC)
//   3. Post: POST /callout/create { coinMint, thesis, marketCap }
//
// The callout posts as the user's pump.fun profile, so callout rewards
// (USDC, daily, based on volume driven) accrue to them.

const API = 'https://frontend-api-v3.pump.fun';
let jwt = null;
let jwtTs = 0;
const JWT_TTL_MS = 20 * 3600 * 1000; // refresh every 20h
let _kp = null;

async function keypair() {
  if (_kp) return _kp;
  const [{ Keypair }, bs58mod] = await Promise.all([import('@solana/web3.js'), import('bs58')]);
  const bs58 = bs58mod.default || bs58mod;
  const sk = process.env.WALLET_PRIVATE_KEY;
  if (!sk) throw new Error('WALLET_PRIVATE_KEY not set');
  _kp = { kp: Keypair.fromSecretKey(bs58.decode(sk)), bs58 };
  return _kp;
}

async function auth() {
  if (jwt && Date.now() - jwtTs < JWT_TTL_MS) return jwt;
  const { kp, bs58 } = await keypair();
  const { default: nacl } = await import('tweetnacl');
  const address = kp.publicKey.toBase58();
  const ts = Math.floor(Date.now() / 1000);
  const msgBytes = new TextEncoder().encode(`Sign in to pump.fun: ${ts}`);
  const sigBytes = nacl.sign.detached(msgBytes, kp.secretKey);
  const sigB58 = bs58.encode(Buffer.from(sigBytes));
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, signature: sigB58, timestamp: ts }),
  });
  if (!res.ok) throw new Error(`auth/login failed: ${res.status}`);
  const setCookie = res.headers.get('set-cookie') || '';
  const m = setCookie.match(/auth_token=([^;]+)/);
  if (m) { jwt = m[1]; }
  else {
    const data = await res.json().catch(() => ({}));
    jwt = data.token || data.auth_token || null;
  }
  if (!jwt) throw new Error('no auth_token in login response');
  jwtTs = Date.now();
  console.log('[callout] authenticated as', address.slice(0, 8) + '...');
  return jwt;
}

// Generate a punchy thesis from the entry signal.
// v: { symbol, mc, price }, sig: { setup, metrics }
export function thesis(v, sig) {
  const mc = v.mc ? (v.mc >= 1e6 ? `$${(v.mc / 1e6).toFixed(1)}M` : `$${Math.round(v.mc / 1e3)}K`) : '';
  const parts = [];
  const setup = (sig.setup || '').toLowerCase();
  const m = sig.metrics || {};
  if (setup.includes('volume') || m.volSpike) parts.push('volume building fast');
  if (setup.includes('trend')) parts.push('trending hard');
  if (setup.includes('mover')) parts.push('moving up the movers board');
  if (setup.includes('new')) parts.push('fresh launch with early traction');
  if (m.holders && m.holders > 300) parts.push(`${m.holders} holders and climbing`);
  const why = parts.length ? parts.join(', ') : 'strong early signals';
  const sym = v.symbol || 'this one';
  return `In on ${sym} ${mc} — ${why}. Thesis playing out, watching closely.`.slice(0, 280);
}

export async function postCallout(v, sig) {
  const token = await auth();
  const body = {
    coinMint: v.address,
    thesis: thesis(v, sig),
    marketCap: Math.round(v.mc || 0),
  };
  const res = await fetch(`${API}/callout/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': `auth_token=${token}` },
    body: JSON.stringify(body),
  });
  if (res.status === 409) { console.log(`[callout] already called out ${v.symbol}, skipping`); return { skipped: 'duplicate' }; }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`callout/create failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => ({}));
  console.log(`[callout] posted for ${v.symbol}: "${body.thesis.slice(0, 60)}..."`);
  return { ok: true, id: data.id || data.calloutId || null };
}
