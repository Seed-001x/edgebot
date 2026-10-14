// callout.js — posts pump.fun callouts when the bot enters a position.
//
// Flow:
//   1. Auth: sign "Sign in to pump.fun: <ts>" with the wallet key → POST /auth/login → JWT
//   2. Research: read what the coin says it is (pump.fun description, website, X).
//   3. Thesis: the WHOLE post is a thesis — why this coin exists and what it is —
//      written by the LLM from the research in a plain, casual trader voice
//      (one or two short sentences; if it's a meme, name the joke).
//      (Rebuilt 2026-10-14, user: the v2 format — an LLM clause stapled to a
//      code-built facts line of entry mc / % moves / volume / buy share — was a
//      stats readout, not a call. He revoked it: "no numbers or stats… just
//      thesis." The facts line and the stats-only fallback are deleted.)
//      HARD RULE: no numbers or stats in the post text, ever — no digits, no %,
//      no $ amounts, no time-window fragments. The final text is validated
//      before posting; a violating draft is retried once with the violation
//      named, then replaced by a simple name/description line ("cute cat."
//      register), and if even that can't be made clean the callout is skipped.
//   4. Post: POST /callout/create { coinMint, thesis, marketCap } — marketCap
//      is API data the card needs; it is never rendered into the post text.
//
// The callout posts as the user's pump.fun profile, so callout rewards
// (USDC, daily, based on volume driven) accrue to them.
//
// Env:
//   WALLET_PRIVATE_KEY   required (signs the pump.fun login)
//   OPENAI_API_KEY       optional; without it, callouts use the simple fallback (or skip)
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
/* Thesis — the whole post. No numbers, no stats, ever.                */
/* ------------------------------------------------------------------ */

const BANNED = /\b(moon|mooning|gem|ape[ds]?|lfg|fomo|100x|1000x|send(ing)? it|don'?t miss|sleep(ing)? on|explode|viral|guaranteed|next \w+ coin)\b/i;
const DISCLAIM = /\b(not (financial )?advice|nfa|dyor|risky|be careful|invalid if)\b/i;
// "just" is NOT filler in this format — it is the user's own register ("just say
// cute cat") — so it left the fluff list in the 2026-10-14 rewrite. The rest of
// the list still guards against intensifier stuffing.
const FLUFF = /\b(whopping|massive|huge|insane|crazy|pure momentum|momentum play|incredible|amazing)\b/i;

/** Why a draft thesis is unpostable, or null if it is clean. The stat patterns
 *  are the user's hard rule (2026-10-14): any digit, any %, any $ amount. The
 *  $cashtag ($musclecat) is the coin's NAME, not a stat, and is allowed. */
export function thesisViolation(raw) {
  if (!raw) return 'it was empty';
  const t = String(raw);
  if (/\d/.test(t)) return 'it contained a number';
  if (/%/.test(t)) return 'it contained a percent sign';
  if (/\$\s?\d/.test(t)) return 'it contained a dollar amount';
  if (BANNED.test(t)) return 'it used a banned hype word';
  if (DISCLAIM.test(t)) return 'it contained a disclaimer';
  if (FLUFF.test(t)) return 'it used filler words';
  return null;
}

/** Clean a draft into a postable thesis, or null. A null here means the text
 *  must never be posted — every path that produces post text ends here. */
export function validateThesis(raw) {
  if (!raw) return null;
  const t = String(raw).trim().replace(/\s+/g, ' ').replace(/^["'“”]+|["'“”]+$/g, '').trim().toLowerCase();
  if (t.length < 3 || t.length > 280) return null;
  if (t === 'none') return null;
  return thesisViolation(t) ? null : t;
}

async function llmWrite(prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
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
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const txt = data.choices?.[0]?.message?.content;
    return txt == null ? null : String(txt);
  } catch { return null; }
}

const THESIS_RULES = 'Hard rules: NO numbers or stats of any kind — no digits, no percentages, no dollar amounts, no market cap, no volume, no time windows. No hype words (moon, gem, viral, lfg, fomo). No disclaimers, no explainer phrases. Plain casual trader voice, lowercase, confident and simple.';

/** The LLM writes the whole thesis from the research. One retry with the
 *  violation named; a second failure returns null (caller falls back). The
 *  entry signal is never passed in — its numbers must not be recited. */
export async function llmThesis(r, v) {
  if (!process.env.OPENAI_API_KEY) return null;
  const name = (r.name || v.name || '').trim();
  const sym = (r.symbol || v.symbol || '').replace(/^\$/, '').trim();
  const src = [r.description && `description: ${r.description}`, r.site && `website: ${r.site}`, r.xText && `X: ${r.xText}`].filter(Boolean).join('\n');
  let base;
  if (src.replace(/\s/g, '').length >= 40) {
    base = `You are posting a callout for a coin you just bought on pump.fun. Write the thesis: why this coin exists and what it is, in one or two short casual sentences. Base it only on the research below — what the project itself says it is. If it is a meme, name the joke. ${THESIS_RULES} You may tag the coin once as $${sym || 'coin'}. If the research says nothing concrete about what the coin is, reply with exactly: NONE

Coin: ${name} ($${sym})
Research:
${src.slice(0, 1800)}

Return only the post text or NONE.`;
  } else {
    // No links, no usable description — the NAME is the story. Keep it stupidly
    // simple; the user's own anchor for this case is "just say cute cat."
    if (!name && !sym) return null;
    base = `A memecoin is named "${name}" with ticker $${sym}. It has no website, no socials, no usable description — the name IS the whole pitch. Write the callout post: one or two very short casual sentences saying what the name is riffing on, the way a trader would say it. Keep it stupidly simple — "cute cat." energy is exactly right. Do not invent features, rewards or promises the name does not state. ${THESIS_RULES} You may tag the coin once as $${sym}. If the name is random letters with no readable reference, reply with exactly: NONE

Return only the post text or NONE.`;
  }
  let prompt = base;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llmWrite(prompt);
    if (raw == null) return null;
    const clean = validateThesis(raw);
    if (clean) return clean;
    const why = thesisViolation(raw) || 'it broke the format rules';
    prompt = `${base}\n\nYour previous attempt was rejected because ${why}. Rewrite it with zero numbers and zero stats.`;
  }
  return null;
}

/** The simple fallback (replaces the deleted stats fallback): a plain line in
 *  the user's register, number-free by construction — the project's own first
 *  sentence if it survives validation, else a name riff ("muscle cat. looks
 *  good."), else null so the callout is skipped. Never a stats line. */
export function simpleFallback(r, v) {
  r = r || {}; v = v || {};
  const desc = clip(r.description || '', 300);
  if (desc) {
    const first = (desc.split(/(?<=[.!?])\s+/)[0] || '').trim();
    const clean = validateThesis(first);
    if (clean && clean.length >= 12) return clean;
  }
  const name = String(r.name || v.name || '').replace(/\s+/g, ' ').trim();
  if (name) {
    const clean = validateThesis(`${name}. looks good.`);
    if (clean) return clean;
  }
  const sym = String(r.symbol || v.symbol || '').replace(/^\$/, '').trim();
  if (sym) {
    const clean = validateThesis(`$${sym}. looks good.`);
    if (clean) return clean;
  }
  return null;
}

/** Build the entry callout text: research → LLM thesis → simple fallback →
 *  null (skip). sig is accepted for call-site compatibility and deliberately
 *  unused: the entry signal's numbers are never rendered into the post. */
export async function buildThesis(v, sig) {
  let r = {};
  try { r = await research(v); } catch (e) { console.log('[callout] research failed:', e.message); }
  const text = await llmThesis(r, v).catch(() => null);
  if (text) { console.log(`[callout] thesis for ${v.symbol}: llm`); return text; }
  const fb = simpleFallback(r, v);
  if (fb) console.log(`[callout] thesis for ${v.symbol}: simple fallback`);
  return fb;
}

// Follow-up posts. Pass sig.stillHolding = false after the bot sells so the post stays true.
// Number-free like everything else — the gain is a stat and never renders.
function progressThesis(v, sig) {
  const sym = '$' + (v.symbol || '???').replace(/^\$/, '').toLowerCase();
  if (sig.stillHolding === false) return `took profit on ${sym}. called it here first.`;
  return `${sym} still running since the call.`;
}

export async function postCallout(v, sig = {}) {
  const token = await auth();
  const isProgress = !!sig.progress;
  const draft = isProgress ? progressThesis(v, sig) : await buildThesis(v, sig);
  // Final hard gate: whatever produced the draft, a violating string cannot post.
  const text = validateThesis(draft);
  if (!text) { console.log(`[callout] no clean thesis for ${v.symbol} — skipping callout`); return { skipped: 'no-clean-thesis' }; }
  const body = {
    coinMint: v.address,
    thesis: text,
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

// For testing without posting: node -e "import('./src/callout.js').then(m=>m.previewThesis({address:'<mint>',symbol:'CAT',name:'Cat'}).then(console.log))"
export async function previewThesis(v, sig = {}) { return buildThesis(v, sig); }
