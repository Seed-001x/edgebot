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
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://pump.fun',
      'Referer': 'https://pump.fun/',
    },
    body: JSON.stringify({ address, signature: sigB58, timestamp: ts }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`auth/login failed: ${res.status} ${txt.slice(0, 300)}`);
  }
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

// Generate a human-sounding thesis via OpenAI, fallback to template.
async function aiThesis(v, sig) {
  const key = process.env.OPENAI_API_KEY;
  // Pull the coin's real metadata so the thesis can talk about what the coin actually is
  let meta = {};
  try {
    const r = await fetch(`${API}/coins/${v.address}`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) { const c = await r.json(); meta = { description: (c.description || '').slice(0, 200), twitter: c.twitter, telegram: c.telegram, website: c.website, name: c.name }; }
  } catch {}
  if (!key) return templateThesis(v, sig);
  const mc = v.mc ? (v.mc >= 1e6 ? `$${(v.mc / 1e6).toFixed(1)}M` : `$${Math.round(v.mc / 1e3)}K`) : 'unknown MC';
  const m = sig.metrics || {};
  const about = meta.description ? `About the coin: "${meta.description}".` : `Coin name: ${meta.name || v.name || v.symbol}.`;
  const socials = [meta.twitter && 'has Twitter', meta.telegram && 'has Telegram', meta.website && 'has website'].filter(Boolean).join(', ') || 'no socials listed';
  const prompt = `You are a Solana memecoin trader with a big following. You just bought $${v.symbol || '???'} and you're posting a callout on pump.fun to get people to buy. Your callouts move markets — write like it.

Coin: $${v.symbol || '???'} at ${mc} market cap.
${about}
Socials: ${socials}. Setup that flagged it: ${sig.setup || 'momentum'}. Holders: ${m.holders || '?'}. 1h volume: $${m.volH1 || '?'}. Buys/sells 5m: ${m.buysM5 ?? '?'}/${m.sellsM5 ?? '?'}.

Rules:
- Max 220 chars. 2-3 punchy sentences.
- Lead with a real THESIS: what's the narrative, why is THIS coin the one, why NOW.
- Interpret the numbers silently — never explain what the data "means" (no "this means real bids", no "volume relative to MC"). Just state your read with confidence.
- Never meta-commentate on your own analysis. Sound like you glanced at the chart and KNOW, not like you're showing your work.
- Create urgency without sounding desperate. Confidence, not begging.
- First person. Casual degen voice. No hashtags, no emojis, no disclaimers, no "dyor".
- Make the reader feel like they'll miss it if they don't look right now.`;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 100,
        temperature: 0.9,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = await res.json();
    const txt = data.choices?.[0]?.message?.content?.trim();
    if (txt) return txt.slice(0, 280);
  } catch (e) {
    console.log('[callout] AI thesis failed, using template:', e.message);
  }
  return templateThesis(v, sig);
}

function templateThesis(v, sig) {
  const mc = v.mc ? (v.mc >= 1e6 ? `$${(v.mc / 1e6).toFixed(1)}M` : `$${Math.round(v.mc / 1e3)}K`) : '';
  const sym = v.symbol || 'this one';
  const m = sig.metrics || {};
  const templates = [
    `Aped ${sym} ${mc} — volume's picking up, holders climbing. Watching close.`,
    `In on ${sym} ${mc}. Early volume building, looks like it's got legs.`,
    `${sym} ${mc} caught my eye — buyers stepping in. Let's see where this goes.`,
    `Grabbed ${sym} ${mc}. Chart's waking up, volume coming in.`,
    `${sym} ${mc} — fresh momentum, holders ticking up. Riding this one.`,
    `Aped ${sym} at ${mc}. Volume profile looks strong, not sleeping on this.`,
  ];
  // Pick based on symbol hash for variety (not random, so it's stable per coin)
  let h = 0;
  for (let i = 0; i < sym.length; i++) h = (h * 31 + sym.charCodeAt(i)) % templates.length;
  return templates[h].slice(0, 280);
}

export function thesis(v, sig) { return templateThesis(v, sig); }

function progressThesis(v, sig) {
  const gain = sig.gainPct || 20;
  const sym = v.symbol || 'this one';
  const templates = [
    `${sym} climbing, up ${gain}% from my call. Thesis playing out.`,
    `Called ${sym} and it's up ${gain}% already. Still holding.`,
    `${sym} +${gain}% since the callout. Volume still coming in.`,
    `Update on ${sym}: up ${gain}%. This one's got legs.`,
  ];
  let h = 0;
  for (let i = 0; i < sym.length; i++) h = (h * 31 + sym.charCodeAt(i)) % templates.length;
  return templates[h].slice(0, 280);
}

export async function postCallout(v, sig) {
  const token = await auth();
  const isProgress = !!(sig && sig.progress);
  const body = {
    coinMint: v.address,
    thesis: isProgress ? progressThesis(v, sig) : await aiThesis(v, sig),
    marketCap: Math.round(v.mc || 0),
  };
  const res = await fetch(`${API}/callout/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://pump.fun',
      'Referer': 'https://pump.fun/',
      'Cookie': `auth_token=${token}`,
    },
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
