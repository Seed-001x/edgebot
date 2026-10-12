// callout.js — posts pump.fun callouts when the bot enters a position.
//
// Flow:
//   1. Auth: sign "Sign in to pump.fun: <ts>" with the wallet key → POST /auth/login → JWT
//   2. Research: read the coin's pump.fun description, its website, and its X post/profile
//   3. Thesis: an LLM writes a short thesis from ONLY what step 2 found, plus 1–2 stats
//   4. Post: POST /callout/create { coinMint, thesis, marketCap }
//
// The callout posts as the user's pump.fun profile, so callout rewards
// (USDC, daily, based on volume driven) accrue to them.
//
// Env:
//   WALLET_PRIVATE_KEY   required (signs the pump.fun login)
//   OPENAI_API_KEY       optional; without it, callouts fall back to a stats-only line
//   OPENAI_MODEL         optional, default gpt-4o-mini
//   X_BEARER_TOKEN       optional; official X API. Without it, X posts are read via
//                        the public fxtwitter API (free, no key, can be flaky)

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

/* ------------------------------------------------------------------ */
/* Research: what is this coin, in its own words?                      */
/* ------------------------------------------------------------------ */

const UA = 'Mozilla/5.0 (compatible; EdgebotCallout/1.0)';
const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// Only fetch public http(s) sites; skip localhost / private ranges and link hubs we can't read.
function safeUrl(raw) {
  try {
    const u = new URL(String(raw).trim().startsWith('http') ? raw : 'https://' + raw);
    if (!/^https?:$/.test(u.protocol)) return null;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.)/.test(h) || h.endsWith('.local')) return null;
    return u;
  } catch { return null; }
}

async function fetchCoin(address) {
  try {
    const r = await fetch(`${API}/coins/${address}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return {};
    const c = await r.json();
    return { name: c.name, symbol: c.symbol, description: clip(c.description, 600), twitter: c.twitter, telegram: c.telegram, website: c.website };
  } catch { return {}; }
}

// Pull the readable text out of a website: title, meta description, then visible body text.
async function fetchWebsite(raw) {
  const u = safeUrl(raw);
  if (!u) return '';
  const h = u.hostname.replace(/^www\./, '');
  if (/^(x|twitter)\.com$|^t\.me$|^pump\.fun$|^dexscreener\.com$|^linktr\.ee$/.test(h)) return '';
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(7000) });
    if (!r.ok || !/text\/html/i.test(r.headers.get('content-type') || '')) return '';
    const html = (await r.text()).slice(0, 400_000);
    const meta = (re) => (html.match(re) || [])[1] || '';
    const title = meta(/<title[^>]*>([^<]{0,200})<\/title>/i);
    const desc = meta(/<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]+content=["']([^"']{0,400})/i)
              || meta(/<meta[^>]+content=["']([^"']{0,400})["'][^>]+(?:name|property)=["'](?:og:)?description["']/i);
    const body = html
      .replace(/<(script|style|noscript|svg|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&[a-z]+;/gi, ' ');
    return clip([title, desc, body].filter(Boolean).join(' — '), 1500);
  } catch { return ''; }
}

// X links on pump.fun come as a post (x.com/user/status/123), a profile (x.com/user)
// or a community (x.com/i/communities/123, not readable without login).
function parseX(raw) {
  const u = safeUrl(raw);
  if (!u || !/^(www\.)?(x|twitter)\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === 'i') return null;
  const s = parts.indexOf('status');
  if (s > 0 && parts[s + 1]) return { user: parts[0], id: parts[s + 1].replace(/\D/g, '') };
  if (parts[0]) return { user: parts[0] };
  return null;
}

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

// Returns up to ~1200 chars of what the project says on X: the linked post, the bio, recent posts.
async function fetchX(raw) {
  const x = parseX(raw);
  if (!x) return '';
  const out = [];
  const bearer = process.env.X_BEARER_TOKEN;
  try {
    if (bearer) {
      const H = { Authorization: `Bearer ${bearer}` };
      if (x.id) {
        const t = await getJson(`https://api.x.com/2/tweets/${x.id}?tweet.fields=note_tweet`, H);
        out.push('Linked post: ' + (t.data?.note_tweet?.text || t.data?.text || ''));
      }
      const u = await getJson(`https://api.x.com/2/users/by/username/${encodeURIComponent(x.user)}?user.fields=description`, H);
      if (u.data?.description) out.push('Bio: ' + u.data.description);
      if (!x.id && u.data?.id) {
        const tl = await getJson(`https://api.x.com/2/users/${u.data.id}/tweets?max_results=5&exclude=retweets,replies`, H);
        (tl.data || []).forEach(t => out.push('Post: ' + t.text));
      }
    } else {
      // Free fallback: fxtwitter's public JSON API.
      if (x.id) {
        const t = await getJson(`https://api.fxtwitter.com/${encodeURIComponent(x.user)}/status/${x.id}`);
        if (t.tweet?.text) out.push('Linked post: ' + t.tweet.text);
        if (t.tweet?.author?.description) out.push('Bio: ' + t.tweet.author.description);
      } else {
        const p = await getJson(`https://api.fxtwitter.com/${encodeURIComponent(x.user)}`);
        if (p.user?.description) out.push('Bio: ' + p.user.description);
      }
    }
  } catch (e) {
    console.log('[callout] X read failed:', e.message);
  }
  return clip(out.join(' | ').replace(/https?:\/\/t\.co\/\S+/g, ''), 1200);
}

async function research(v) {
  const coin = await fetchCoin(v.address);
  const [site, xText] = await Promise.all([fetchWebsite(coin.website), fetchX(coin.twitter)]);
  return { ...coin, site, xText };
}

/* ------------------------------------------------------------------ */
/* Thesis                                                              */
/* ------------------------------------------------------------------ */

const fmtUsd = n => n == null || !isFinite(n) ? null : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;

// The stats worth quoting, in plain words. Only includes numbers we actually have.
function statLines(v, sig) {
  const m = sig.metrics || {};
  const s = [];
  if (v.mc) s.push(`market cap ${fmtUsd(v.mc)}`);
  if (m.volH1) s.push(`${fmtUsd(Number(m.volH1))} volume in the last hour`);
  if (m.holders) s.push(`${m.holders} holders`);
  if (m.buysM5 != null && m.sellsM5 != null) s.push(`${m.buysM5} buys vs ${m.sellsM5} sells in 5 min`);
  if (m.chgM5 != null) s.push(`${Number(m.chgM5) >= 0 ? '+' : ''}${Math.round(Number(m.chgM5))}% in 5 min`);
  if (m.gradSec != null) s.push(`graduated in ${m.gradSec}s`);
  return s;
}

const BANNED = /\b(moon|mooning|gem|ape[ds]?|lfg|fomo|100x|1000x|send(ing)? it|don'?t miss|sleep(ing)? on|explode|viral|guaranteed|next \w+ coin)\b/i;
const DISCLAIM = /\b(not (financial )?advice|nfa|dyor|risky|be careful|invalid if)\b/i;

async function aiThesis(v, sig) {
  const r = await research(v);
  const stats = statLines(v, sig);
  const sym = (r.symbol || v.symbol || '???').replace(/^\$/, '');
  const haveContext = !!(r.description || r.site || r.xText);
  const key = process.env.OPENAI_API_KEY;
  if (!key) return statsThesis(sym, stats);

  const prompt = `Write a pump.fun callout for $${sym}, a coin I just bought.

What the project says about itself (this is the ONLY source for the thesis):
- Name: ${r.name || v.name || sym}
- pump.fun description: ${r.description || '(none)'}
- Website: ${r.site || '(none or unreadable)'}
- X: ${r.xText || '(none or unreadable)'}

Numbers at entry: ${stats.join('; ') || '(none)'}

Write it like this:
- Sentence 1 is the thesis: what this project is or claims to do, and why that could catch on right now. Describe it the way the project describes itself. ${haveContext ? '' : 'There is no project info, so say it is a pure momentum play and lead with the numbers.'}
- Sentence 2: the one or two most striking numbers from the list, stated plainly.
- Lowercase, casual, like a trader posting from their phone. Under 220 characters total.

Never:
- call it a memecoin, meme, token, or "this coin"
- invent features, partners, listings, team members, news or attention that aren't in the text above
- use hype words (moon, gem, ape, 100x, hidden gem, don't sleep on, lfg) or exclamation marks
- add warnings, risks, exit levels or disclaimers
- wrap the callout in quotes

Return only the callout text.`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 120,
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = await res.json();
    let txt = (data.choices?.[0]?.message?.content || '').trim().replace(/^["'“”]+|["'“”]+$/g, '').replace(/!+/g, '.');
    if (!txt) throw new Error('empty reply');
    if (BANNED.test(txt) || DISCLAIM.test(txt) || /\bmeme ?coin\b/i.test(txt)) throw new Error('reply broke the style rules: ' + txt.slice(0, 80));
    console.log(`[callout] thesis for ${sym} from ${[r.description && 'description', r.site && 'website', r.xText && 'X'].filter(Boolean).join('+') || 'stats only'}`);
    return txt.slice(0, 280);
  } catch (e) {
    console.log('[callout] AI thesis failed, using stats line:', e.message);
  }
  return statsThesis(sym, stats);
}

// Fallback when there's no LLM or it misbehaves: plain, true, no invented narrative.
function statsThesis(sym, stats) {
  const pick = stats.slice(0, 2).join(', ');
  return (pick ? `in $${sym.toLowerCase()}. ${pick}.` : `in $${sym.toLowerCase()}.`).slice(0, 280);
}

export function thesis(v, sig) { return statsThesis((v.symbol || '???').replace(/^\$/, ''), statLines(v, sig || {})); }

// Follow-up posts. Pass sig.stillHolding = false after the bot sells so the post stays true.
function progressThesis(v, sig) {
  const gain = Math.round(sig.gainPct ?? 20);
  const sym = '$' + (v.symbol || '???').replace(/^\$/, '').toLowerCase();
  if (sig.stillHolding === false) return `took profit on ${sym} at +${gain}% from the call.`;
  return `${sym} up ${gain}% since the call.`;
}

export async function postCallout(v, sig = {}) {
  const token = await auth();
  const isProgress = !!sig.progress;
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
  return { ok: true, id: data.id || data.calloutId || null, thesis: body.thesis };
}

// For testing without posting: node -e "import('./callout.js').then(m=>m.previewThesis({address:'<mint>',symbol:'HIRE',mc:68000},{metrics:{volH1:26000,holders:400}}).then(console.log))"
export async function previewThesis(v, sig = {}) { return aiThesis(v, sig); }
