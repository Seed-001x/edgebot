// callout.js — posts pump.fun callouts when the bot enters a position.
//
// Flow:
//   1. Auth: sign "Sign in to pump.fun: <ts>" with the wallet key → POST /auth/login → JWT
//   2. Facts: the callout body is built BY CODE from the entry signal — the setup that
//      fired, the exact entry market cap, and the decisive numbers for that setup.
//      (Rebuilt 2026-10-12, user: LLM-written callouts were "meh" — facts passed
//      through the model came out as filler like "pure momentum play"/"whopping".)
//   3. Narrative clause (optional): if research (description/website/X) finds a real
//      project story, the LLM may contribute ONE short clause saying what the coin
//      is. It is validated to contain no numbers and no hype, so it can never
//      corrupt the facts; absent a real story, the callout is facts only.
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

const BANNED = /\b(moon|mooning|gem|ape[ds]?|lfg|fomo|100x|1000x|send(ing)? it|don'?t miss|sleep(ing)? on|explode|viral|guaranteed|next \w+ coin)\b/i;
const DISCLAIM = /\b(not (financial )?advice|nfa|dyor|risky|be careful|invalid if)\b/i;
const FLUFF = /\b(whopping|massive|huge|insane|crazy|just|pure momentum|momentum play|incredible|amazing)\b/i;

/**
 * The fact block: built by code from the entry signal, never by the LLM.
 * Setup-aware — a trend callout leads with the hour, a pop with the 5 minutes —
 * and every number is one the bot actually measured at the decision.
 */
export function factBlock(v, sig) {
  const m = (sig && sig.metrics) || {};
  const sym = '$' + (v.symbol || '???').replace(/^\$/, '').toLowerCase();
  const head = `in ${sym}` + (v.mc ? ` at ${fmtUsd(v.mc)} mc` : '');
  const pct = (x) => `${Number(x) >= 0 ? '+' : ''}${Math.round(Number(x))}%`;
  const parts = [];
  let setupWord = sig && sig.setup ? `${sig.setup}: ` : '';
  if (sig && sig.setup === 'trend') {
    if (m.chgH1 != null) parts.push(`${pct(m.chgH1)} on the hour`);
    if (m.chgM5 != null) {
      parts.push(`${pct(m.chgM5)} last 5m`);
      if (Number(m.chgM5) >= Number(m.chgH1 ?? 0) && Number(m.chgM5) >= 20) setupWord = 'trend still accelerating: ';
    }
    if (m.volH1) parts.push(`${fmtUsd(Number(m.volH1))}/h volume`);
  } else {
    if (m.gainPct != null) parts.push(`${pct(m.gainPct)} in 5 min`);
    else if (m.chgM5 != null) parts.push(`${pct(m.chgM5)} in 5 min`);
    if (m.volM5) parts.push(`${fmtUsd(Number(m.volM5))} 5m volume`);
    else if (m.volH1) parts.push(`${fmtUsd(Number(m.volH1))}/h volume`);
    if (m.drawFromPeak != null && Number(m.drawFromPeak) <= 0.02) parts.push('right at its highs');
  }
  if (m.holders) parts.push(`${m.holders} holders`);
  if (m.buyRatioM5 != null && Number(m.buyRatioM5) >= 0.5) parts.push(`${Math.round(Number(m.buyRatioM5) * 100)}% buys`);
  return (parts.length ? `${head}. ${setupWord}${parts.join(', ')}.` : `${head}.`).slice(0, 280);
}

/** A narrative clause may only describe what the coin IS — no numbers, no hype, no filler. */
export function validClause(txt) {
  if (!txt) return null;
  const t = String(txt).trim().replace(/^["'“”]+|["'“”]+$/g, '').replace(/[.!]+$/, '').trim().toLowerCase();
  if (t.length < 12 || t.length > 90) return null;
  if (/\d/.test(t)) return null; // facts live in the fact block; the clause carries none
  if (BANNED.test(t) || DISCLAIM.test(t) || FLUFF.test(t)) return null;
  if (/\bmeme ?coin\b|\bmemecoin\b|\btoken\b|\bthis coin\b/.test(t)) return null;
  if (t === 'none') return null;
  return t;
}

async function narrativeClause(r) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const src = [r.description && `description: ${r.description}`, r.site && `website: ${r.site}`, r.xText && `X: ${r.xText}`].filter(Boolean).join('\n');
  if (src.replace(/\s/g, '').length < 40) return null; // nothing real to summarize
  const prompt = `From this text about a crypto project, write ONE clause (max 12 words, lowercase, NO numbers, no hype, no prices) saying what the project IS or claims to do, in its own framing — e.g. "a prediction market for livestream events" or "the mascot dog of the eth merge anniversary". If the text is generic, empty, just links, or says nothing concrete about what the project is, reply with exactly: NONE

Text:
${src.slice(0, 1800)}

Return only the clause or NONE.`;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 40,
        temperature: 0.4,
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return validClause(data.choices?.[0]?.message?.content || '');
  } catch { return null; }
}

async function aiThesis(v, sig) {
  const facts = factBlock(v, sig);
  try {
    const r = await research(v);
    const clause = await narrativeClause(r);
    if (clause) {
      console.log(`[callout] thesis for ${v.symbol}: narrative clause + facts`);
      return `${clause} — ${facts}`.slice(0, 280);
    }
    console.log(`[callout] thesis for ${v.symbol}: facts only`);
  } catch (e) {
    console.log('[callout] research/clause failed, facts only:', e.message);
  }
  return facts;
}

export function thesis(v, sig) { return factBlock(v, sig || {}); }

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
