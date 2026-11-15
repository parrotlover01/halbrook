// Halbrook server: serves the site (with HTTP range support for video) and the app API.
// API: wallet sign-in, per-model token balances, swaps at the live price ratio, and a chat
// that routes each request to the cheapest host through OpenRouter and debits the balance.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const { Pool } = require('pg');
const { verifyMessage, getAddress } = require('viem');

const ROOT = path.join(__dirname, 'public'), PORT = process.env.PORT || 3000;
const TEST_MODE = process.env.TEST_MODE === '1';
const MARGIN = Number(process.env.MARGIN || 0.05);
const SWAP_FEE = 0.003;
const SECRET = process.env.SESSION_SECRET || '';
const OR_KEY = process.env.OPENROUTER_API_KEY || '';
const MODELS = ['anthropic/claude-opus-5.5', 'anthropic/claude-fable-5.2', 'openai/gpt-6-astra', 'openai/gpt-6.1-sol', 'openai/gpt-6.1-terra', 'google/gemini-4-carbon', 'mistralai/mistral-large-4-0', 'deepseek/deepseek-v4-pro', 'x-ai/grok-4.7'];
const FAUCET = { model: 'mistralai/mistral-large-4-0', tokens: 2_000_000 }; // test credit, once per wallet
const FAUCET_PER_IP = Number(process.env.FAUCET_PER_IP || 3);            // test credits per IP per day
const CHAT_DAILY_USD = Number(process.env.CHAT_DAILY_USD || 10);         // hard cap on what chat + API may spend per day, all users
const FAUCET_TOTAL_USD = Number(process.env.FAUCET_TOTAL_USD || 100);    // all test credit ever given, all wallets together
// market layer: each model trades at reference x (1 + premium); swaps move the premium, it stays in the band
// and fades back toward 0 when nobody trades. Using tokens (chat, API) always counts them at the reference price.
/* real money: USDG on Robinhood Chain. Balances are in micro-USDG (6 decimals): 1e6 = 1 USDG.
   Real money only runs with TEST_MODE off; the first live start wipes every test balance and premium. */
const USDG = 'usdg';
const USDG_PRICE = { name: 'USDG', blend: 1e-6, pin: 0, pout: 0 };
const CHAIN = { id: 4663, name: 'Robinhood Chain', rpc: process.env.RH_RPC || 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com' };
const USDG_CONTRACT = process.env.USDG_CONTRACT || '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';   // checked on-chain: "Global Dollar", USDG, 6 decimals
const TREASURY = (() => { try { return process.env.TREASURY_ADDRESS ? getAddress(process.env.TREASURY_ADDRESS.trim()) : null; } catch { return null; } })();
const LIVE = !TEST_MODE && !!TREASURY;
const WD_ON = LIVE && process.env.WITHDRAWALS_ENABLED === '1' && !!process.env.TREASURY_PRIVATE_KEY;
const WD_MAX = Number(process.env.WITHDRAW_MAX_USD || 100);              // per withdrawal
const WD_DAILY = Number(process.env.WITHDRAW_DAILY_USD || 200);          // per account, 24 h
const WD_AUTO = Number(process.env.WITHDRAW_AUTO_USD || 50);             // above this, waits for the admin
const WD_GLOBAL = Number(process.env.WITHDRAW_GLOBAL_DAILY_USD || 1000); // all accounts, 24 h
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const CONFIRMATIONS = 5;
let liveReady = false;
const BAND = 0.30;                                                       // premium stays within -30% .. +30%
const DEPTH_USD = Number(process.env.MARKET_DEPTH_USD || 10);           // USD of net flow that moves a premium by 10 points
const HALF_LIFE_H = Number(process.env.MARKET_HALF_LIFE_H || 0);        // 0 = premiums never fade on their own: a pure player-vs-player market
const WD_FEE = Number(process.env.WITHDRAW_FEE_USD || 0.5);             // flat fee per withdrawal, covers gas

const db = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }) : null;

async function migrate() {
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (address text PRIMARY KEY, created timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS balances (address text NOT NULL, model text NOT NULL, amount numeric NOT NULL DEFAULT 0, PRIMARY KEY (address, model));
    CREATE TABLE IF NOT EXISTS ledger (id bigserial PRIMARY KEY, address text NOT NULL, kind text NOT NULL, model text, amount numeric NOT NULL, meta jsonb, ts timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS nonces (nonce text PRIMARY KEY, created timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS ledger_addr ON ledger (address, ts DESC);
    CREATE INDEX IF NOT EXISTS ledger_kind_ts ON ledger (kind, ts);
    CREATE TABLE IF NOT EXISTS api_keys (id bigserial PRIMARY KEY, address text NOT NULL, hash text NOT NULL UNIQUE, prefix text NOT NULL, label text, created timestamptz NOT NULL DEFAULT now(), last_used timestamptz, spent numeric NOT NULL DEFAULT 0, revoked boolean NOT NULL DEFAULT false);
    CREATE INDEX IF NOT EXISTS api_keys_addr ON api_keys (address);
    CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text NOT NULL);
    CREATE TABLE IF NOT EXISTS deposits (tx_hash text NOT NULL, log_index int NOT NULL, address text NOT NULL, amount numeric NOT NULL, block bigint NOT NULL, ts timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tx_hash, log_index));
    CREATE TABLE IF NOT EXISTS withdrawals (id bigserial PRIMARY KEY, address text NOT NULL, amount numeric NOT NULL, status text NOT NULL, tx_hash text, error text, created timestamptz NOT NULL DEFAULT now(), updated timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS withdrawals_addr ON withdrawals (address, created DESC);
    CREATE INDEX IF NOT EXISTS deposits_addr ON deposits (address, ts DESC);
    CREATE TABLE IF NOT EXISTS memories (id bigserial PRIMARY KEY, address text NOT NULL, data text NOT NULL, created timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS memories_addr ON memories (address, created);
    CREATE TABLE IF NOT EXISTS market (model text PRIMARY KEY, premium numeric NOT NULL DEFAULT 0, updated timestamptz NOT NULL DEFAULT now());
  `);
  await db.query('ALTER TABLE market ADD COLUMN IF NOT EXISTS ref numeric; ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS fee numeric NOT NULL DEFAULT 0');
  // repair: no NaN or negative balances, no balances in unknown models; then forbid them for good
  await db.query("UPDATE balances SET amount = 0 WHERE amount = 'NaN' OR amount < 0");
  await db.query('DELETE FROM balances WHERE NOT (model = ANY($1))', [[...MODELS, USDG]]);
  await db.query("ALTER TABLE balances ADD CONSTRAINT balances_sane CHECK (amount >= 0 AND amount <> 'NaN')").catch(() => {});
  await db.query('INSERT INTO market (model) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING', [MODELS]);
  if (LIVE) await goLive();
}
// first start with real money: every balance and premium so far was test money, so it all goes back to zero,
// and deposits are counted from this block on. Runs once.
async function goLive() {
  const done = await db.query("SELECT value FROM settings WHERE key = 'live_since'");
  if (!done.rows.length) {
    const head = parseInt(await rpc('eth_blockNumber', []), 16);
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      await c.query('UPDATE balances SET amount = 0');
      await c.query('UPDATE market SET premium = 0, updated = now()');
      await c.query("INSERT INTO ledger (address, kind, amount, meta) VALUES ('*', 'go-live-reset', 0, $1)", [JSON.stringify({ block: head })]);
      await c.query("INSERT INTO settings (key, value) VALUES ('live_since', $1), ('deposit_block', $2)", [new Date().toISOString(), String(head)]);
      await c.query('COMMIT');
      console.log('live: test balances reset, deposits counted from block', head);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  liveReady = true;
}

/* ---------- live prices (OpenRouter public API), USD per token ---------- */
let PRICES = {};
async function refreshPrices() {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models'); if (!r.ok) return;
    const all = (await r.json()).data, next = {};
    for (const m of all) if (MODELS.includes(m.id)) {
      const pin = +m.pricing.prompt || 0, pout = +m.pricing.completion || 0;
      next[m.id] = { name: m.name.replace(/^[^:]+:\s*/, ''), pin, pout, blend: (3 * pin + pout) / 4 };
    }
    if (Object.keys(next).length) { PRICES = next; await anchorMarket().catch(e => console.error('anchor', e.message)); }
  } catch (e) { console.error('prices', e.message); }
}
// When a host changes a model's official price, keep its market price where it was and let the premium
// take the difference (within the band). Holders are not moved by a price list update: only trades move prices.
async function anchorMarket() {
  if (!db) return;
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query('SELECT model, premium, updated, ref FROM market WHERE model = ANY($1) ORDER BY model FOR UPDATE', [MODELS]);
    for (const r of rows) {
      const P = priceOf(r.model); if (!P) continue;
      const old = r.ref == null ? null : Number(r.ref);
      if (old == null) { await c.query('UPDATE market SET ref = $2 WHERE model = $1', [r.model, P.blend]); continue; }
      if (Math.abs(old - P.blend) / P.blend < 1e-9) continue;
      const p0 = clampP(decayed(r.premium, r.updated)), p1 = clampP(old * (1 + p0) / P.blend - 1);
      await c.query('UPDATE market SET premium = $2, ref = $3, updated = now() WHERE model = $1', [r.model, p1, P.blend]);
      await c.query("INSERT INTO ledger (address, kind, model, amount, meta) VALUES ('*', 'reprice', $1, 0, $2)", [r.model, JSON.stringify({ refFrom: old, refTo: P.blend, premFrom: p0, premTo: p1 })]);
      console.log('reprice', r.model, old, '->', P.blend, 'premium', p0.toFixed(4), '->', p1.toFixed(4));
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

/* ---------- sessions: HMAC-signed token, no server state ---------- */
const b64 = s => Buffer.from(s).toString('base64url');
function sign(address) {
  const body = b64(JSON.stringify({ a: address, e: Date.now() + 7 * 864e5 }));
  return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}
function auth(req) {
  const h = req.headers.authorization || '', t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [body, mac] = t.split('.'); if (!body || !mac || !SECRET) return null;
  const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.e > Date.now() ? p.a : null; } catch { return null; }
}

/* ---------- helpers ---------- */
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readJSON(req, limit = 64 * 1024) {
  return new Promise((ok, bad) => { let n = 0, chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { if (chunks) { chunks = null; bad(Object.assign(new Error('too large'), { code: 413 })); req.resume(); } } else if (chunks) chunks.push(c); });
    req.on('end', () => { if (!chunks) return; try { ok(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { bad(new Error('bad json')); } });
    req.on('error', bad); });
}
const lastHit = new Map();
function throttled(key, ms) { const t = Date.now(), p = lastHit.get(key) || 0; if (t - p < ms) return true; lastHit.set(key, t); return false; }
// counted limits per window (e.g. per IP), pruned with the throttle map
const counts = new Map();
function overLimit(key, max, ms) { const t = Date.now(), c = counts.get(key); if (!c || c.reset < t) { counts.set(key, { n: 1, reset: t + ms }); return false; } c.n++; return c.n > max; }
setInterval(() => { const t = Date.now(); for (const [k, v] of lastHit) if (t - v > 60_000) lastHit.delete(k); for (const [k, v] of counts) if (v.reset < t) counts.delete(k); }, 60_000).unref();
// client IP: Railway's proxy appends the real address last in X-Forwarded-For
const ipOf = req => { const x = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean); return x[x.length - 1] || req.socket.remoteAddress || '?'; };
// only real model ids, never inherited object keys like "constructor"
const priceOf = id => (typeof id === 'string' && MODELS.includes(id) && Object.hasOwn(PRICES, id)) ? PRICES[id] : null;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

/* ---------- metered calls: reserve the worst case, call, then settle the real cost ---------- */
// Reserving up front (atomically) means no one can spend more than they hold, even with
// many requests in parallel; the unused part goes back to the balance when the answer is in.
async function reserve(user, model, messages, maxOut) {
  const P = priceOf(model); if (!P) return { code: 400, error: 'Unknown model' };
  const spent = await db.query("SELECT COALESCE(SUM((meta->>'paid')::numeric), 0) AS usd FROM ledger WHERE kind = 'chat' AND ts > now() - interval '1 day'");
  if (Number(spent.rows[0].usd) >= CHAT_DAILY_USD) return { code: 503, error: 'Halbrook has reached its daily usage limit. Back tomorrow.' };
  const chars = JSON.stringify(messages).length;
  // long prompt, full answer, host up to 25% above the official price, plus the margin
  const worstUsd = (chars / 3 * P.pin + maxOut * P.pout) * 1.25 * (1 + MARGIN);
  // pay with this model's tokens if you hold enough, otherwise straight from your USDG at the real cost
  for (const [payIn, unit, min] of [[model, P.blend, 2000], [USDG, 1e-6, 10_000]]) {
    const hold = Math.max(min, Math.ceil(worstUsd / unit));
    const { rowCount } = await db.query('UPDATE balances SET amount = amount - $3 WHERE address = $1 AND model = $2 AND amount >= $3', [user, payIn, hold]);
    if (rowCount) return { user, model, P, payIn, unit, hold };
  }
  return { code: 402, error: 'Not enough tokens for this model, and not enough USDG. Deposit USDG or swap some first.' };
}
async function release(h) { await db.query('UPDATE balances SET amount = amount + $3 WHERE address = $1 AND model = $2', [h.user, h.payIn, h.hold]); }
async function settle(h, usage, provider, meta) {
  const u = usage || {}, pin = u.prompt_tokens || 0, pout = u.completion_tokens || 0, P = h.P;
  const refCost = pin * P.pin + pout * P.pout;                                  // what the official price would charge
  const paid = typeof u.cost === 'number' && u.cost >= 0 ? u.cost : refCost;    // what the routed host actually charged
  const charge = paid * (1 + MARGIN);                                           // what the user pays
  const debit = Math.ceil(charge / h.unit);                                     // in this model's tokens, or in micro-USDG
  const back = h.hold - debit;                                                  // unused part of the reservation
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query('UPDATE balances SET amount = GREATEST(amount + $3, 0) WHERE address = $1 AND model = $2', [h.user, h.payIn, back]);
    await c.query("INSERT INTO ledger (address, kind, model, amount, meta) VALUES ($1,'chat',$2,$3,$4)", [h.user, h.payIn, -debit, JSON.stringify({ model: h.model, pin, pout, paid, refCost, provider: typeof provider === 'string' ? provider.slice(0, 60) : null, ...meta })]);
    if (meta && meta.key) await c.query('UPDATE api_keys SET spent = spent + $2, last_used = now() WHERE id = $1', [meta.key, charge]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  return { pin, pout, refCost, paid, charge, debit, payIn: h.payIn };
}
function upstream(body, stream = false) {
  return fetch('https://openrouter.ai/api/v1/chat/completions', {
    signal: AbortSignal.timeout(stream ? 300_000 : 120_000), method: 'POST',
    headers: { Authorization: 'Bearer ' + OR_KEY, 'Content-Type': 'application/json', 'X-Title': 'Halbrook' },
    body: JSON.stringify({ ...body, stream, provider: { sort: 'price', allow_fallbacks: true }, usage: { include: true } }),
  });
}

/* ---------- shared memory: notes every model receives, encrypted at rest (AES-256-GCM) ---------- */
const MEM_KEY = crypto.createHash('sha256').update('halbrook-memory:' + SECRET).digest();
const MEM_MAX = 50, MEM_LEN = 500;
function seal(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', MEM_KEY, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function unseal(b64) {
  try { const b = Buffer.from(b64, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', MEM_KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); } catch { return null; }
}
async function notes(user) {
  const { rows } = await db.query('SELECT id, data, created FROM memories WHERE address = $1 ORDER BY created', [user]);
  return rows.map(r => ({ id: String(r.id), text: unseal(r.data), created: r.created })).filter(n => n.text != null);
}
async function memoryMessage(user, chat, withNotes = true) {
  const list = withNotes ? await notes(user) : []; let t = '';
  if (chat) t += 'You are answering on Halbrook, where the user can switch models in the middle of a conversation: earlier assistant replies may come from other models. Continue naturally.\n';
  if (list.length) t += 'Notes the user saved for every model they use (their shared memory):\n' + list.map(n => '- ' + n.text).join('\n').slice(0, 6000);
  return t ? { role: 'system', content: t } : null;
}

/* ---------- Robinhood Chain: deposits in, withdrawals out ---------- */
async function rpc(method, params) {
  const r = await fetch(CHAIN.rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message || 'rpc error'); return j.result;
}
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topicOf = a => '0x' + a.toLowerCase().slice(2).padStart(64, '0');
let scanning = false;
// credits each USDG transfer to the treasury to the wallet that sent it, once, after CONFIRMATIONS blocks
async function scanDeposits() {
  if (!liveReady || scanning) return; scanning = true;
  try {
    const head = parseInt(await rpc('eth_blockNumber', []), 16) - CONFIRMATIONS;
    let from = Number((await db.query("SELECT value FROM settings WHERE key = 'deposit_block'")).rows[0].value) + 1;
    while (from <= head) {
      const to = Math.min(head, from + 1999);
      const logs = await rpc('eth_getLogs', [{ address: USDG_CONTRACT, topics: [TRANSFER, null, topicOf(TREASURY)], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
      const c = await db.connect();
      try {
        await c.query('BEGIN');
        for (const l of logs) {
          if (l.removed || l.address.toLowerCase() !== USDG_CONTRACT.toLowerCase()) continue;
          const sender = getAddress('0x' + l.topics[1].slice(26)), amount = BigInt(l.data).toString();
          if (amount === '0') continue;
          const ins = await c.query('INSERT INTO deposits (tx_hash, log_index, address, amount, block) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [l.transactionHash, parseInt(l.logIndex, 16), sender, amount, parseInt(l.blockNumber, 16)]);
          if (!ins.rowCount) continue;
          await c.query('INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING', [sender]);
          await c.query('INSERT INTO balances (address, model, amount) VALUES ($1,$2,$3) ON CONFLICT (address, model) DO UPDATE SET amount = balances.amount + EXCLUDED.amount', [sender, USDG, amount]);
          await c.query("INSERT INTO ledger (address, kind, model, amount, meta) VALUES ($1,'deposit',$2,$3,$4)", [sender, USDG, amount, JSON.stringify({ tx: l.transactionHash })]);
          console.log('deposit', sender, Number(amount) / 1e6, 'USDG');
        }
        await c.query("UPDATE settings SET value = $1 WHERE key = 'deposit_block'", [String(to)]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
      from = to + 1;
    }
  } catch (e) { console.error('deposits', e.message); } finally { scanning = false; }
}
const ERC20 = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] }];
let hotWallet = null;
function hot() {   // the key stays in the environment; it is never logged or sent anywhere
  if (!hotWallet) {
    const { createWalletClient, createPublicClient, http, defineChain } = require('viem');
    const { privateKeyToAccount } = require('viem/accounts');
    const chain = defineChain({ id: CHAIN.id, name: CHAIN.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [CHAIN.rpc] } } });
    const k = process.env.TREASURY_PRIVATE_KEY.trim();
    const account = privateKeyToAccount(k.startsWith('0x') ? k : '0x' + k);
    hotWallet = { wallet: createWalletClient({ account, chain, transport: http(CHAIN.rpc) }), pub: createPublicClient({ chain, transport: http(CHAIN.rpc) }) };
  }
  return hotWallet;
}
async function refundWithdrawal(id, status, from, error = null) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query('UPDATE withdrawals SET status = $2, error = COALESCE($4, error), updated = now() WHERE id = $1 AND status = ANY($3) RETURNING address, amount + fee AS back', [id, status, from, error]);
    if (!rows.length) { await c.query('ROLLBACK'); return false; }
    await c.query('INSERT INTO balances (address, model, amount) VALUES ($1,$2,$3) ON CONFLICT (address, model) DO UPDATE SET amount = balances.amount + EXCLUDED.amount', [rows[0].address, USDG, rows[0].back]);
    await c.query("INSERT INTO ledger (address, kind, model, amount, meta) VALUES ($1,'withdraw-refund',$2,$3,$4)", [rows[0].address, USDG, rows[0].back, JSON.stringify({ id: String(id), status })]);
    await c.query('COMMIT'); return true;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
// Owes: every balance at market price (USDG at $1) plus withdrawals not yet paid.
// Holds: USDG on the treasury address and on the hot wallet, read on chain.
let solv = { at: 0, data: null };
async function solvency(force = false) {
  if (!force && solv.data && Date.now() - solv.at < 60_000) return solv.data;
  const [bal, prem, pend] = await Promise.all([
    db.query("SELECT model, SUM(amount) AS n FROM balances WHERE amount > 0 GROUP BY model"), premiums(),
    db.query("SELECT COALESCE(SUM(amount), 0) AS n FROM withdrawals WHERE status IN ('queued', 'review', 'sending', 'sent')")]);
  let atMarket = Number(pend.rows[0].n) / 1e6, atRef = atMarket, usdgOwed = 0;
  for (const r of bal.rows) { const P = assetPrice(r.model); if (!P) continue; const n = Number(r.n), p = r.model === USDG ? 0 : prem[r.model] || 0;
    atMarket += n * P.blend * (1 + p); atRef += n * P.blend; if (r.model === USDG) usdgOwed += n / 1e6; }
  let held = null, hotAddr = null, hotUsdg = null, treasuryUsdg = null, hotEth = null;
  if (LIVE) {
    const read = async a => Number(BigInt(await rpc('eth_call', [{ to: USDG_CONTRACT, data: '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0') }, 'latest']))) / 1e6;
    treasuryUsdg = await read(TREASURY); held = treasuryUsdg;
    if (WD_ON) { hotAddr = hot().wallet.account.address;
      if (hotAddr.toLowerCase() !== TREASURY.toLowerCase()) { hotUsdg = await read(hotAddr); held += hotUsdg; } else hotUsdg = treasuryUsdg;
      hotEth = Number(BigInt(await rpc('eth_getBalance', [hotAddr, 'latest']))) / 1e18; }
  }
  const data = { owedAtMarket: atMarket, owedAtReference: atRef, usdgOwed, held, treasuryUsdg, hotWallet: hotAddr, hotUsdg, hotEth, margin: held == null ? null : held - atMarket, ok: held == null || held >= atMarket, checked: new Date().toISOString() };
  if (!data.ok) console.error(`RESERVE ALERT: holds ${held.toFixed(2)} USDG, owes ${atMarket.toFixed(2)} at market. Withdrawals paused.`);
  solv = { at: Date.now(), data }; return data;
}
const solvent = async () => { try { return (await solvency()).ok; } catch (e) { console.error('solvency', e.message); return false; } };
let sending = false;
// one withdrawal at a time. Anything uncertain goes to 'review' and is never re-sent on its own: no double payout.
async function processWithdrawals() {
  if (!WD_ON || !liveReady || sending) return; sending = true;
  try {
    const { wallet, pub } = hot();
    for (const w of (await db.query("SELECT id, tx_hash FROM withdrawals WHERE status = 'sent' AND updated < now() - interval '2 minutes'")).rows) {
      const rc = await pub.getTransactionReceipt({ hash: w.tx_hash }).catch(() => null);
      if (rc && rc.status === 'success') await db.query("UPDATE withdrawals SET status = 'done', updated = now() WHERE id = $1", [w.id]);
      else if (rc) await refundWithdrawal(w.id, 'failed', ['sent'], 'reverted on chain');
    }
    for (;;) {
      const { rows } = await db.query("UPDATE withdrawals SET status = 'sending', updated = now() WHERE id = (SELECT id FROM withdrawals WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id, address, amount");
      if (!rows.length) break;
      const w = rows[0], amount = BigInt(w.amount);
      if (!(await solvent())) { await db.query("UPDATE withdrawals SET status = 'queued', error = 'paused: reserve check', updated = now() WHERE id = $1", [w.id]); break; }
      const have = await pub.readContract({ address: USDG_CONTRACT, abi: ERC20, functionName: 'balanceOf', args: [wallet.account.address] });
      if (have < amount) { await db.query("UPDATE withdrawals SET status = 'queued', error = 'hot wallet low', updated = now() WHERE id = $1", [w.id]); console.error('withdrawals: the hot wallet needs more USDG'); break; }
      let hash;
      try { hash = await wallet.writeContract({ address: USDG_CONTRACT, abi: ERC20, functionName: 'transfer', args: [getAddress(w.address), amount] }); }
      catch (e) { await db.query("UPDATE withdrawals SET status = 'review', error = $2, updated = now() WHERE id = $1", [w.id, String(e.shortMessage || e.message).slice(0, 200)]); console.error('withdraw send failed, moved to review', w.id); break; }
      await db.query("UPDATE withdrawals SET status = 'sent', tx_hash = $2, updated = now() WHERE id = $1", [w.id, hash]);
      const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 }).catch(() => null);
      if (rc && rc.status === 'success') await db.query("UPDATE withdrawals SET status = 'done', updated = now() WHERE id = $1", [w.id]);
      else if (rc) await refundWithdrawal(w.id, 'failed', ['sent'], 'reverted on chain');
    }
  } catch (e) { console.error('withdrawals', e.shortMessage || e.message); } finally { sending = false; }
}

/* ---------- market ---------- */
const clampP = p => Math.max(-BAND, Math.min(BAND, p));
const decayed = (p, updated) => HALF_LIFE_H > 0 ? Number(p) * Math.pow(0.5, (Date.now() - new Date(updated).getTime()) / 36e5 / HALF_LIFE_H) : Number(p);
const assetPrice = id => id === USDG ? USDG_PRICE : priceOf(id);
async function premiums(q = db, lock = null) {
  const { rows } = await q.query('SELECT model, premium, updated FROM market' + (lock ? ' WHERE model = ANY($1) ORDER BY model FOR UPDATE' : ''), lock ? [lock] : []);
  const out = {}; for (const r of rows) out[r.model] = clampP(decayed(r.premium, r.updated)); return out;
}
// price of a swap: the premium of what you sell goes down, of what you buy goes up; you trade at the
// midpoint of each move, so a big order pays its own price impact.
function quote(from, to, amt, prem) {
  const PF = assetPrice(from), PT = assetPrice(to); if (!PF || !PT || from === to) return null;
  const a0 = from === USDG ? 0 : prem[from] || 0, b0 = to === USDG ? 0 : prem[to] || 0;   // USDG is always worth $1
  const v0 = amt * PF.blend * (1 + a0), dp = v0 * 0.10 / DEPTH_USD;
  const a1 = from === USDG ? 0 : clampP(a0 - dp), b1 = to === USDG ? 0 : clampP(b0 + dp);
  const value = amt * PF.blend * (1 + (a0 + a1) / 2);
  const out = Math.floor(value / (PT.blend * (1 + (b0 + b1) / 2)) * (1 - SWAP_FEE));
  return { out, valueUsd: value, fee: SWAP_FEE, from: { premium: a0, after: a1 }, to: { premium: b0, after: b1 } };
}
function marketView(prem) {
  return MODELS.filter(m => priceOf(m)).map(m => { const ref = PRICES[m].blend * 1e6, p = prem[m] || 0;
    return { id: m, name: PRICES[m].name, ref, premium: p, market: ref * (1 + p), floor: ref * (1 - BAND), cap: ref * (1 + BAND) }; });
}
async function balances(address) {
  const [{ rows }, prem] = await Promise.all([db.query("SELECT model, amount FROM balances WHERE address = $1 AND amount > 0 AND amount <> 'NaN' ORDER BY model", [address]), premiums()]);
  return rows.map(r => { const P = assetPrice(r.model), n = Number(r.amount), p = r.model === USDG ? 0 : prem[r.model] || 0;
    return { model: r.model, tokens: n, usd: P ? n * P.blend * (1 + p) : null, usdRef: P ? n * P.blend : null }; });
}

/* ---------- API ---------- */
async function api(req, res, p) {
  if (!db) return send(res, 503, { error: 'Database not configured' });
  try {
    if (p === '/api/config' && req.method === 'GET')
      return send(res, 200, { funds: { live: LIVE && liveReady, address: LIVE ? TREASURY : null, chainId: CHAIN.id, chainName: CHAIN.name, rpc: 'https://rpc.mainnet.chain.robinhood.com', explorer: CHAIN.explorer, usdg: USDG_CONTRACT, confirmations: CONFIRMATIONS, withdrawals: WD_ON, wdMax: WD_MAX, wdDaily: WD_DAILY, wdAuto: WD_AUTO, wdFee: WD_FEE }, testMode: TEST_MODE, chat: !!OR_KEY, margin: MARGIN, swapFee: SWAP_FEE, models: MODELS.filter(m => PRICES[m]).map(m => ({ id: m, name: PRICES[m].name, blendPerM: PRICES[m].blend * 1e6 })) });

    if (p === '/api/market' && req.method === 'GET')
      return send(res, 200, { band: BAND, depthUsd: DEPTH_USD, halfLifeH: HALF_LIFE_H, swapFee: SWAP_FEE, models: marketView(await premiums()) });

    if (p === '/api/quote' && req.method === 'GET') {
      if (overLimit('quote:' + ipOf(req), 240, 60_000)) return send(res, 429, { error: 'Slow down a little' });
      const u = new URL(req.url, 'http://x'), amt = Math.floor(Number(u.searchParams.get('tokens')));
      if (!Number.isSafeInteger(amt) || amt <= 0 || amt > 1e12) return send(res, 400, { error: 'Bad amount' });
      const q = quote(u.searchParams.get('from'), u.searchParams.get('to'), amt, await premiums());
      return q ? send(res, 200, q) : send(res, 400, { error: 'Pick two different models' });
    }

    if (p === '/api/nonce' && req.method === 'GET') {
      if (overLimit('nonce:' + ipOf(req), 30, 60_000)) return send(res, 429, { error: 'Slow down a little' });
      const nonce = crypto.randomBytes(12).toString('hex');
      await db.query('INSERT INTO nonces (nonce) VALUES ($1)', [nonce]);
      await db.query("DELETE FROM nonces WHERE created < now() - interval '15 minutes'");
      return send(res, 200, { nonce });
    }

    if (p === '/api/login' && req.method === 'POST') {
      if (overLimit('login:' + ipOf(req), 20, 60_000)) return send(res, 429, { error: 'Slow down a little' });
      const { address, message, signature } = await readJSON(req);
      let addr; try { addr = getAddress(address); } catch { return send(res, 400, { error: 'Bad address' }); }
      // exact message only: a signature made for anything else can never open a session
      const m = typeof message === 'string' && /^Sign in to Halbrook\nAddress: (0x[0-9a-fA-F]{40})\nNonce: ([0-9a-f]{24})$/.exec(message);
      if (!m || m[1].toLowerCase() !== addr.toLowerCase() || typeof signature !== 'string') return send(res, 400, { error: 'Bad message' });
      const nonce = m[2];
      const { rowCount } = await db.query("DELETE FROM nonces WHERE nonce = $1 AND created > now() - interval '10 minutes'", [nonce]);
      if (!rowCount) return send(res, 400, { error: 'Nonce expired, try again' });
      const ok = await verifyMessage({ address: addr, message, signature }).catch(() => false);
      if (!ok) return send(res, 401, { error: 'Signature does not match' });
      await db.query('INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING', [addr]);
      return send(res, 200, { token: sign(addr), address: addr });
    }

    if (p.startsWith('/api/admin/')) {
      const h = req.headers.authorization || '', t = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : ''), k = Buffer.from(ADMIN_TOKEN);
      if (ADMIN_TOKEN.length < 24 || t.length !== k.length || !crypto.timingSafeEqual(t, k)) return send(res, 401, { error: 'Not allowed' });
      if (p === '/api/admin/solvency' && req.method === 'GET') return send(res, 200, await solvency(true));
      if (p === '/api/admin/withdrawals' && req.method === 'GET') {
        const { rows } = await db.query("SELECT id, address, amount, status, tx_hash, error, created FROM withdrawals WHERE status IN ('review', 'queued', 'sending', 'sent') ORDER BY id");
        return send(res, 200, { withdrawals: rows.map(w => ({ ...w, id: String(w.id), usdg: Number(w.amount) / 1e6 })) });
      }
      const m = /^\/api\/admin\/withdrawals\/(\d{1,18})\/(approve|reject)$/.exec(p);
      if (m && req.method === 'POST') {
        if (m[2] === 'approve') {
          const { rowCount } = await db.query("UPDATE withdrawals SET status = 'queued', error = NULL, updated = now() WHERE id = $1 AND status = 'review'", [m[1]]);
          if (rowCount) setImmediate(processWithdrawals);
          return send(res, rowCount ? 200 : 404, rowCount ? { ok: true } : { error: 'Not waiting for review' });
        }
        const ok = await refundWithdrawal(m[1], 'rejected', ['review']);
        return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Not waiting for review' });
      }
      return send(res, 404, { error: 'Not found' });
    }

    const user = auth(req);
    if (!user) return send(res, 401, { error: 'Sign in with your wallet first' });

    /* funds: deposits are credited by the chain watcher; withdrawals go to the signed-in wallet only */
    if (p === '/api/funds' && req.method === 'GET') {
      const [d, w] = await Promise.all([
        db.query('SELECT tx_hash, amount, ts FROM deposits WHERE address = $1 ORDER BY ts DESC LIMIT 10', [user]),
        db.query('SELECT id, amount, status, tx_hash, created FROM withdrawals WHERE address = $1 ORDER BY id DESC LIMIT 10', [user])]);
      return send(res, 200, { deposits: d.rows.map(x => ({ tx: x.tx_hash, usdg: Number(x.amount) / 1e6, ts: x.ts })), withdrawals: w.rows.map(x => ({ id: String(x.id), usdg: Number(x.amount) / 1e6, status: x.status, tx: x.tx_hash, ts: x.created })) });
    }
    if (p === '/api/withdraw' && req.method === 'POST') {
      if (!WD_ON || !liveReady) return send(res, 403, { error: 'Withdrawals are not open yet' });
      if (throttled('wd:' + user, 3000)) return send(res, 429, { error: 'Slow down a little' });
      const units = Math.round(Number((await readJSON(req)).amount) * 1e6);
      const fee = Math.round(WD_FEE * 1e6);
      if (!Number.isSafeInteger(units) || units < Math.max(1e6, fee + 5e5)) return send(res, 400, { error: `Withdraw at least ${Math.max(1, WD_FEE + 0.5)} USDG` });
      if (!(await solvent())) return send(res, 503, { error: 'Withdrawals are paused for a reserve check. Your balance is safe.' });
      if (units > WD_MAX * 1e6) return send(res, 400, { error: `${WD_MAX} USDG at most per withdrawal` });
      const c = await db.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['withdrawals']);
        const sums = await c.query("SELECT COALESCE(SUM(amount) FILTER (WHERE address = $1), 0) AS mine, COALESCE(SUM(amount), 0) AS everyone FROM withdrawals WHERE created > now() - interval '1 day' AND status NOT IN ('rejected', 'failed')", [user]);
        if (Number(sums.rows[0].mine) + units > WD_DAILY * 1e6) { await c.query('ROLLBACK'); return send(res, 400, { error: `${WD_DAILY} USDG at most per day` }); }
        if (Number(sums.rows[0].everyone) + units > WD_GLOBAL * 1e6) { await c.query('ROLLBACK'); return send(res, 503, { error: 'Withdrawals are paused until tomorrow. Your balance is safe.' }); }
        const b = await c.query('SELECT amount FROM balances WHERE address = $1 AND model = $2 FOR UPDATE', [user, USDG]);
        if (!b.rows.length || Number(b.rows[0].amount) < units) { await c.query('ROLLBACK'); return send(res, 400, { error: 'Not enough USDG. Swap some tokens to USDG first.' }); }
        await c.query('UPDATE balances SET amount = amount - $3 WHERE address = $1 AND model = $2', [user, USDG, units]);
        const status = units <= WD_AUTO * 1e6 ? 'queued' : 'review';
        const w = await c.query('INSERT INTO withdrawals (address, amount, fee, status) VALUES ($1,$2,$3,$4) RETURNING id', [user, units - fee, fee, status]);
        await c.query("INSERT INTO ledger (address, kind, model, amount, meta) VALUES ($1,'withdraw',$2,$3,$4)", [user, USDG, -units, JSON.stringify({ id: String(w.rows[0].id) })]);
        await c.query('COMMIT');
        if (status === 'queued') setImmediate(processWithdrawals);
        return send(res, 200, { id: String(w.rows[0].id), status, balances: await balances(user) });
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    }

    if (p === '/api/me' && req.method === 'GET') {
      const { rows } = await db.query("SELECT 1 FROM ledger WHERE address = $1 AND kind = 'faucet' LIMIT 1", [user]);
      return send(res, 200, { address: user, balances: await balances(user), faucetUsed: rows.length > 0 });
    }

    if (p === '/api/faucet' && req.method === 'POST') {
      if (!TEST_MODE) return send(res, 403, { error: 'Test credits are off' });
      if (overLimit('faucet:' + ipOf(req), FAUCET_PER_IP, 864e5)) return send(res, 429, { error: 'Test credit limit reached for today' });
      const c = await db.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['faucet-total']);
        const given = await c.query("SELECT COUNT(*)::int AS n FROM ledger WHERE kind = 'faucet'");
        const each = priceOf(FAUCET.model) ? FAUCET.tokens * priceOf(FAUCET.model).blend : 2;
        if ((given.rows[0].n + 1) * each > FAUCET_TOTAL_USD) { await c.query('ROLLBACK'); return send(res, 410, { error: 'All test credit has been given out. Deposits open soon.' }); }
        const { rows } = await c.query("SELECT 1 FROM ledger WHERE address = $1 AND kind = 'faucet' LIMIT 1", [user]);
        if (rows.length) { await c.query('ROLLBACK'); return send(res, 409, { error: 'Test credit already claimed' }); }
        await c.query('INSERT INTO balances (address, model, amount) VALUES ($1,$2,$3) ON CONFLICT (address, model) DO UPDATE SET amount = balances.amount + EXCLUDED.amount', [user, FAUCET.model, FAUCET.tokens]);
        await c.query("INSERT INTO ledger (address, kind, model, amount, meta) VALUES ($1,'faucet',$2,$3,'{\"test\":true}')", [user, FAUCET.model, FAUCET.tokens]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
      return send(res, 200, { balances: await balances(user) });
    }

    if (p === '/api/swap' && req.method === 'POST') {
      if (throttled('swap:' + user, 1000)) return send(res, 429, { error: 'Slow down a little' });
      const { from, to, tokens } = await readJSON(req);
      const amt = Math.floor(Number(tokens));
      const PF = assetPrice(from), PT = assetPrice(to);
      if (!PF || !PT || from === to) return send(res, 400, { error: 'Pick two different assets' });
      if (!Number.isSafeInteger(amt) || amt <= 0 || amt > 1e12) return send(res, 400, { error: 'Bad amount' });
      const c = await db.connect();
      try {
        await c.query('BEGIN');
        const prem = await premiums(c, [from, to].filter(x => x !== USDG));   // locks the market rows that move
        const q = quote(from, to, amt, prem);
        if (!q || !Number.isSafeInteger(q.out) || q.out < 1) { await c.query('ROLLBACK'); return send(res, 400, { error: 'Amount too small' }); }
        const { rows } = await c.query('SELECT amount FROM balances WHERE address = $1 AND model = $2 FOR UPDATE', [user, from]);
        if (!rows.length || Number(rows[0].amount) < amt) { await c.query('ROLLBACK'); return send(res, 400, { error: 'Not enough tokens' }); }
        await c.query('UPDATE balances SET amount = amount - $3 WHERE address = $1 AND model = $2', [user, from, amt]);
        await c.query('INSERT INTO balances (address, model, amount) VALUES ($1,$2,$3) ON CONFLICT (address, model) DO UPDATE SET amount = balances.amount + EXCLUDED.amount', [user, to, q.out]);
        if (from !== USDG) await c.query('UPDATE market SET premium = $2, updated = now() WHERE model = $1', [from, q.from.after]);
        if (to !== USDG) await c.query('UPDATE market SET premium = $2, updated = now() WHERE model = $1', [to, q.to.after]);
        const meta = JSON.stringify({ to, out: q.out, valueUsd: q.valueUsd, fee: SWAP_FEE, premFrom: [q.from.premium, q.from.after], premTo: [q.to.premium, q.to.after] });
        await c.query("INSERT INTO ledger (address, kind, model, amount, meta) VALUES ($1,'swap',$2,$3,$4)", [user, from, -amt, meta]);
        await c.query('COMMIT');
        return send(res, 200, { gave: amt, got: q.out, quote: q, balances: await balances(user) });
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    }

    if (p === '/api/chat' && req.method === 'POST') {
      if (!OR_KEY) return send(res, 503, { error: 'Chat is not switched on yet' });
      if (throttled('chat:' + user, 1500)) return send(res, 429, { error: 'Slow down a little' });
      const { model, messages, memory } = await readJSON(req, 256 * 1024);
      if (!Array.isArray(messages) || !messages.length || messages.length > 60) return send(res, 400, { error: 'Bad conversation' });
      const clean = messages.map(m => ({ role: m && m.role === 'assistant' ? 'assistant' : 'user', content: String((m && m.content) || '').slice(0, 8000) }));
      const sys = await memoryMessage(user, true, memory !== false); if (sys) clean.unshift(sys);
      const hold = await reserve(user, model, clean, 3000);
      if (hold.error) return send(res, hold.code, { error: hold.error });
      let r, j;
      try {
        r = await upstream({ model, messages: clean, max_tokens: 3000, reasoning: { effort: 'low' } });
        j = await r.json().catch(() => ({}));
      } catch (e) { await release(hold); return send(res, 502, { error: 'The model did not answer. Try again in a moment.' }); }
      if (!r.ok) { await release(hold); console.error('chat upstream', r.status, j.error && j.error.message); return send(res, 502, { error: 'The model did not answer. Try again in a moment.' }); }
      const bill = await settle(hold, j.usage, j.provider, { via: 'chat' });
      const text = j.choices && j.choices[0] && j.choices[0].message ? String(j.choices[0].message.content || '') : '';
      return send(res, 200, { reply: text, provider: typeof j.provider === 'string' ? j.provider.slice(0, 60) : null, tokensIn: bill.pin, tokensOut: bill.pout, charged: bill.charge, officialCost: bill.refCost * (1 + MARGIN), debit: bill.debit, paidIn: bill.payIn === 'usdg' ? 'usdg' : 'tokens', balances: await balances(user) });
    }

    /* shared memory */
    if (p === '/api/memory' && req.method === 'GET') return send(res, 200, { notes: await notes(user) });
    if (p === '/api/memory' && req.method === 'POST') {
      if (throttled('mem:' + user, 500)) return send(res, 429, { error: 'Slow down a little' });
      const text = String((await readJSON(req)).text || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > MEM_LEN) return send(res, 400, { error: `A note is 1 to ${MEM_LEN} characters` });
      const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM memories WHERE address = $1', [user]);
      if (rows[0].n >= MEM_MAX) return send(res, 400, { error: `${MEM_MAX} notes at most. Delete one first.` });
      await db.query('INSERT INTO memories (address, data) VALUES ($1,$2)', [user, seal(text)]);
      return send(res, 200, { notes: await notes(user) });
    }
    if (p === '/api/memory' && req.method === 'DELETE') { await db.query('DELETE FROM memories WHERE address = $1', [user]); return send(res, 200, { notes: [] }); }
    if (p.startsWith('/api/memory/') && req.method === 'DELETE') {
      const id = p.slice(12); if (!/^\d{1,18}$/.test(id)) return send(res, 400, { error: 'Bad note' });
      await db.query('DELETE FROM memories WHERE id = $1 AND address = $2', [id, user]);
      return send(res, 200, { notes: await notes(user) });
    }

    /* API keys: shown once at creation, stored only as a SHA-256 hash, revocable */
    if (p === '/api/keys' && req.method === 'GET') {
      const { rows } = await db.query('SELECT id, prefix, label, created, last_used, spent FROM api_keys WHERE address = $1 AND NOT revoked ORDER BY created DESC', [user]);
      return send(res, 200, { keys: rows.map(k => ({ id: String(k.id), prefix: k.prefix, label: k.label, created: k.created, lastUsed: k.last_used, spent: Number(k.spent) })) });
    }
    if (p === '/api/keys' && req.method === 'POST') {
      if (throttled('key:' + user, 2000)) return send(res, 429, { error: 'Slow down a little' });
      const { label } = await readJSON(req);
      const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM api_keys WHERE address = $1 AND NOT revoked', [user]);
      if (rows[0].n >= 5) return send(res, 400, { error: 'Five keys at most. Revoke one first.' });
      const key = 'hb_' + crypto.randomBytes(24).toString('base64url');
      const ins = await db.query('INSERT INTO api_keys (address, hash, prefix, label) VALUES ($1,$2,$3,$4) RETURNING id', [user, sha(key), key.slice(0, 9), String(label || 'My key').slice(0, 40)]);
      return send(res, 200, { key, id: String(ins.rows[0].id), prefix: key.slice(0, 9) });
    }
    if (p.startsWith('/api/keys/') && req.method === 'DELETE') {
      const id = p.slice(10); if (!/^\d{1,18}$/.test(id)) return send(res, 400, { error: 'Bad key' });
      const { rowCount } = await db.query('UPDATE api_keys SET revoked = true WHERE id = $1 AND address = $2 AND NOT revoked', [id, user]);
      return send(res, rowCount ? 200 : 404, rowCount ? { ok: true } : { error: 'Key not found' });
    }

    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (e.code === 413) return send(res, 413, { error: 'Message too long. Start a new conversation.' });
    console.error('api', p, e.message);
    return send(res, 500, { error: 'Something went wrong' });
  }
}

/* ---------- public API, OpenAI-compatible: base URL https://www.halbrook.xyz/v1, key hb_... ---------- */
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Halbrook-Memory', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '86400' };
const oaErr = (res, code, message, type = 'invalid_request_error') => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS }); res.end(JSON.stringify({ error: { message, type, code } })); };
const modelId = m => typeof m !== 'string' ? null : MODELS.find(id => id === m || id.endsWith('/' + m)) || null;   // "claude-opus-5.5" works too
const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
const inflight = new Map();
async function v1(req, res, p) {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS).end(); return; }
  if (!db) return oaErr(res, 503, 'Service unavailable', 'server_error');
  try {
    if (p === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      return res.end(JSON.stringify({ object: 'list', data: MODELS.filter(m => priceOf(m)).map(m => ({ id: m, object: 'model', created: 0, owned_by: m.split('/')[0], name: PRICES[m].name, pricing: { prompt: PRICES[m].pin, completion: PRICES[m].pout } })) }));
    }
    if (p !== '/v1/chat/completions' || req.method !== 'POST') return oaErr(res, 404, 'Not found');
    const h = req.headers.authorization || '', key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!/^hb_[A-Za-z0-9_-]{32}$/.test(key)) return oaErr(res, 401, 'Missing or malformed API key. Create one on halbrook.xyz.', 'authentication_error');
    const k = await db.query('SELECT id, address FROM api_keys WHERE hash = $1 AND NOT revoked', [sha(key)]);
    if (!k.rows.length) return oaErr(res, 401, 'Invalid or revoked API key', 'authentication_error');
    const keyId = String(k.rows[0].id), user = k.rows[0].address;
    if (!OR_KEY) return oaErr(res, 503, 'Routing is not switched on yet', 'server_error');
    if (overLimit('v1:' + keyId, 60, 60_000)) return oaErr(res, 429, 'Rate limit: 60 requests per minute per key', 'rate_limit_error');
    if ((inflight.get(user) || 0) >= 4) return oaErr(res, 429, 'Four requests at a time per account', 'rate_limit_error');
    const b = await readJSON(req, 1024 * 1024);
    const model = modelId(b.model); if (!model) return oaErr(res, 400, 'Unknown model. GET /v1/models lists them.');
    if (!Array.isArray(b.messages) || !b.messages.length || b.messages.length > 200) return oaErr(res, 400, 'messages must be a non-empty array (200 at most)');
    const messages = [];
    for (const m of b.messages) {
      if (!m || !ROLES.has(m.role)) return oaErr(res, 400, 'Each message needs a valid role');
      const o = { role: m.role, content: m.content == null ? '' : m.content };
      if (typeof o.content !== 'string' && !Array.isArray(o.content)) return oaErr(res, 400, 'content must be a string or an array');
      for (const f of ['name', 'tool_calls', 'tool_call_id']) if (m[f] != null) o[f] = m[f];
      messages.push(o);
    }
    const maxOut = Math.min(Math.max(1, Math.floor(Number(b.max_completion_tokens || b.max_tokens) || 2048)), 8192);
    const body = { model, messages, max_tokens: maxOut };
    for (const f of ['temperature', 'top_p', 'stop', 'seed', 'presence_penalty', 'frequency_penalty', 'tools', 'tool_choice', 'response_format']) if (b[f] != null) body[f] = b[f];
    if (String(req.headers['x-halbrook-memory'] || '').toLowerCase() === 'on' || (b.halbrook && b.halbrook.memory === true)) {
      const sys = await memoryMessage(user, false); if (sys) messages.unshift(sys);
    }
    const hold = await reserve(user, model, { messages, tools: body.tools }, maxOut);
    if (hold.error) return oaErr(res, hold.code, hold.error, hold.code === 402 ? 'insufficient_quota' : 'invalid_request_error');
    inflight.set(user, (inflight.get(user) || 0) + 1);
    const done = () => { const n = (inflight.get(user) || 1) - 1; if (n > 0) inflight.set(user, n); else inflight.delete(user); };
    try {
      let r; try { r = await upstream(body, !!b.stream); } catch (e) { await release(hold); return oaErr(res, 502, 'The model did not answer. Try again.', 'server_error'); }
      if (!r.ok) { const j = await r.json().catch(() => ({})); await release(hold); console.error('v1 upstream', r.status, j.error && j.error.message); return oaErr(res, r.status === 400 ? 400 : 502, r.status === 400 ? 'The model rejected this request' : 'The model did not answer. Try again.', r.status === 400 ? 'invalid_request_error' : 'server_error'); }
      if (!b.stream) {
        const j = await r.json().catch(() => null);
        if (!j || !j.choices) { await release(hold); return oaErr(res, 502, 'Empty answer from the model', 'server_error'); }
        const bill = await settle(hold, j.usage, j.provider, { via: 'api', key: keyId });
        if (j.usage) { delete j.usage.cost; delete j.usage.cost_details; delete j.usage.is_byok; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS });
        return res.end(JSON.stringify({ ...j, model, halbrook: { charged_usd: bill.charge, official_usd: bill.refCost * (1 + MARGIN), host: j.provider || null, paid_in: bill.payIn === 'usdg' ? 'usdg' : 'model_tokens', debited: bill.debit } }));
      }
      // streaming: pass the events through as they come, keep the last usage block to bill it
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', ...CORS });
      let usage = null, provider = null, buf = '';
      const reader = r.body.getReader(), dec = new TextDecoder();
      try {
        for (;;) {
          const { value, done: end } = await reader.read(); if (end) break;
          const text = dec.decode(value, { stream: true }); buf += text;
          let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (line.startsWith('data: {')) { try { const ev = JSON.parse(line.slice(6)); if (ev.usage) usage = ev.usage; if (ev.provider) provider = ev.provider; } catch {} } }
          if (!res.destroyed) res.write(text);   // if the client left, keep reading so the real cost is still known
        }
      } catch (e) { console.error('v1 stream', e.message); }
      await settle(hold, usage || { prompt_tokens: 0, completion_tokens: maxOut }, provider, { via: 'api', key: keyId, stream: true });
      if (!res.destroyed) res.end();
    } finally { done(); }
  } catch (e) {
    if (e.code === 413) return oaErr(res, 413, 'Request too large (1 MB at most)');
    console.error('v1', p, e.message);
    if (!res.headersSent) return oaErr(res, 500, 'Something went wrong', 'server_error');
    res.end();
  }
}

/* ---------- static site ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript', '.ico': 'image/x-icon' };
// Security headers on every response. Pages use inline scripts, so script-src keeps 'unsafe-inline',
// but nothing can be loaded or sent anywhere except this site, Google Fonts and OpenRouter's public API.
const CSP = ["default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob:", "media-src 'self' blob:", "connect-src 'self' https://openrouter.ai",
  "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'", "form-action 'self'"].join('; ');
const SEC = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()', 'Cross-Origin-Opener-Policy': 'same-origin-allow-popups' };
const GZIP = /^(text\/|image\/svg)/;
const ROOT_DIR = ROOT + path.sep;
function serve(req, res, p) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT_DIR) || p.split('/').some(s => s.startsWith('.')) || file.includes('\0')) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const html = type.startsWith('text/html');
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const base = { 'Content-Type': type, 'Cache-Control': html ? 'no-cache' : 'public, max-age=86400, stale-while-revalidate=604800', ETag: etag, 'Last-Modified': st.mtime.toUTCString(), Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, base).end(); return; }
    const stream = (opts) => { const s = fs.createReadStream(file, opts); s.on('error', () => res.destroy()); return s; };
    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim());
    if (range && (range[1] || range[2])) {
      let start, end;
      if (range[1]) { start = +range[1]; end = range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1; }
      else { start = Math.max(0, st.size - +range[2]); end = st.size - 1; }
      if (!(start >= 0) || start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end(); return; }
      res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      stream({ start, end }).pipe(res);
    } else if (GZIP.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.writeHead(200, { ...base, 'Content-Encoding': 'gzip' });
      if (req.method === 'HEAD') return res.end();
      stream().pipe(zlib.createGzip({ level: 6 })).pipe(res);
    } else {
      res.writeHead(200, { ...base, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
      if (req.method === 'HEAD') return res.end();
      stream().pipe(res);
    }
  });
}

const server = http.createServer((req, res) => {
  for (const [k, v] of Object.entries(SEC)) res.setHeader(k, v);
  let p; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (p.startsWith('/api/')) return api(req, res, p);
  if (p.startsWith('/v1/')) return v1(req, res, p);
  serve(req, res, p);
});
server.headersTimeout = 20_000; server.requestTimeout = 120_000;
process.on('uncaughtException', e => console.error('uncaught', e));
process.on('unhandledRejection', e => console.error('unhandled', e));
server.listen(PORT, async () => {
  console.log('Halbrook on :' + PORT, TEST_MODE ? '(test mode)' : '', OR_KEY ? '(chat on)' : '(chat off)');
  try { await migrate(); } catch (e) { console.error('migrate', e.message); }
  await refreshPrices(); setInterval(refreshPrices, 60_000);
  if (LIVE) { setInterval(scanDeposits, 15_000); setInterval(processWithdrawals, 20_000); scanDeposits(); }
  console.log(LIVE ? `real money: deposits to ${TREASURY}, withdrawals ${WD_ON ? 'on' : 'off'}` : 'test money only');
  if (WD_ON) {   // check the key matches the treasury; only the public address is ever logged
    try { const a = hot().wallet.account.address; console.log('hot wallet', a, a.toLowerCase() === TREASURY.toLowerCase() ? '(same as the treasury address)' : '(DIFFERENT from TREASURY_ADDRESS: deposits and withdrawals use two wallets)'); }
    catch (e) { console.error('TREASURY_PRIVATE_KEY is not a valid private key: withdrawals cannot be sent'); }
  }
});
