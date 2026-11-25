import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { deviceSessions, exchangeOrders, tradeProposals } from '../src/db/schema';
import { createHarness, HAS_DB, type Harness, type TestUser } from './helpers';

/** PRD 17.5 acceptance journeys A-E plus auth, watchlist, memory, diagnostics. Real Neon, fake exchange, real routes. */
describe.skipIf(!HAS_DB)('acceptance journeys', () => {
  let h: Harness;
  let alice: TestUser;
  let bob: TestUser;

  beforeAll(async () => {
    h = await createHarness();
    alice = await h.createUser();
    bob = await h.createUser();
  });
  afterAll(async () => h.cleanup());
  beforeEach(() => h.resetFake());

  const say = async (user: TestUser, sessionId: string, text: string, displayedProposalId?: string) => {
    const r = await h.call<any>(user, 'POST', '/agent/message', { sessionId, text, source: 'text', ...(displayedProposalId ? { displayedProposalId } : {}) });
    expect(r.status).toBe(200);
    return r.body.data;
  };
  const texts = (reply: any) => reply.sections.map((s: any) => `${s.label}: ${s.text}`).join(' | ');

  describe('auth & access control', () => {
    it('every private route requires a valid token', async () => {
      for (const [m, u] of [['GET', '/portfolio'], ['GET', '/watchlist'], ['GET', '/memory'], ['POST', '/agent/sessions'], ['POST', '/trades/prepare'], ['GET', '/diagnostics'], ['GET', '/trades/orders']] as const) {
        const r = await h.call<any>(null, m, u, m === 'POST' ? {} : undefined);
        expect(r.status, `${m} ${u}`).toBe(401);
        expect(r.body.error.code).toBe('UNAUTHENTICATED');
      }
      const bad = await h.call<any>({ id: 'x', token: 'nope', headers: { authorization: 'Bearer not-a-real-token' } }, 'GET', '/portfolio');
      expect(bad.status).toBe(401);
    });

    it('pairing: wrong code refused; right code issues a token that works, refreshes (rotating) and logs out', async () => {
      const wrong = await h.call<any>(null, 'POST', '/auth/pair', { pairingCode: 'not-the-code', deviceType: 'simulator' });
      expect(wrong.status).toBe(401);
      expect(wrong.body.error.code).toBe('INVALID_PAIRING_CODE');

      const ok = await h.call<any>(null, 'POST', '/auth/pair', { pairingCode: 'unit-test-pairing-code', deviceType: 'simulator' });
      expect(ok.status).toBe(200);
      const t1 = ok.body.data.accessToken as string;
      const as = (t: string): TestUser => ({ id: ok.body.data.user.id, token: t, headers: { authorization: `Bearer ${t}` } });

      expect((await h.call<any>(as(t1), 'GET', '/auth/session')).status).toBe(200);
      const refreshed = await h.call<any>(as(t1), 'POST', '/auth/refresh');
      const t2 = refreshed.body.data.accessToken as string;
      expect(t2).not.toBe(t1);
      expect((await h.call<any>(as(t1), 'GET', '/auth/session')).status).toBe(401); // old token dead immediately
      expect((await h.call<any>(as(t2), 'GET', '/auth/session')).status).toBe(200);
      await h.call<any>(as(t2), 'POST', '/auth/logout');
      expect((await h.call<any>(as(t2), 'GET', '/auth/session')).status).toBe(401);
    });

    it('an expired or revoked device session is rejected; only a hash of the token is stored', async () => {
      const u = await h.createUser();
      const rows = await h.db.select().from(deviceSessions).where(eq(deviceSessions.userId, u.id));
      expect(rows[0]!.sessionTokenHash).not.toContain(u.token);
      expect(rows[0]!.sessionTokenHash).toMatch(/^[0-9a-f]{64}$/);
      await h.db.update(deviceSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(deviceSessions.userId, u.id));
      expect((await h.call<any>(u, 'GET', '/auth/session')).status).toBe(401);
    });

    it('rejects malformed input with a safe validation error (no internals)', async () => {
      const r = await h.call<any>(alice, 'POST', '/agent/message', { sessionId: 'not-a-uuid', text: '' });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(r.body)).not.toMatch(/at .*\.ts|node_modules|stack/i);
      const unknown = await h.call<any>(alice, 'GET', '/nope');
      expect(unknown.status).toBe(404);
    });

    it('health is public and minimal; diagnostics needs auth and shows no secrets', async () => {
      const health = await h.call<any>(null, 'GET', '/health');
      expect(health.body.data).toEqual({ status: 'ok', database: 'connected', exchange: 'available', environment: 'testnet' });
      const diag = await h.call<any>(alice, 'GET', '/diagnostics');
      expect(diag.body.data.exchange.environment).toBe('testnet');
      expect(JSON.stringify(diag.body)).not.toMatch(/postgres|secret|apikey|api_key/i);
      expect(health.headers['x-request-id']).toBeTruthy();
    });
  });

  describe('Journey A: start a session', () => {
    it('creates a session and greets with verified portfolio facts', async () => {
      const r = await h.call<any>(alice, 'POST', '/agent/sessions');
      expect(r.status).toBe(200);
      const g = r.body.data.greeting;
      expect(g.intent).toBe('START_SESSION');
      expect(texts(g)).toContain('FACT: Portfolio about 76,000.00 USDT across 3 priced assets (testnet)');
      expect(texts(g)).toContain('Watchlist:');
      expect(r.body.data.session.status).toBe('active');
    });

    it('says so plainly (and shows no values) when the exchange is down', async () => {
      h.fake.down = true;
      const r = await h.call<any>(alice, 'POST', '/agent/sessions');
      expect(r.status).toBe(200);
      expect(texts(r.body.data.greeting)).toContain('unavailable');
      expect(texts(r.body.data.greeting)).not.toMatch(/\d{2},\d{3}/);
    });
  });

  describe('Journey B: portfolio', () => {
    it('answers from account data with coverage and excludes unpriced assets', async () => {
      h.fake.balances.set('JUNK', { free: '10000', locked: '0' });
      const sid = await h.startSession(alice);
      const r = await say(alice, sid, 'show me my portfolio');
      expect(r.intent).toBe('GET_PORTFOLIO');
      expect(texts(r)).toContain('Total about 76,000.00 USDT over 3 priced assets (testnet). 1 unpriced assets are excluded.');
      expect(r.uiAction).toEqual({ type: 'NAVIGATE', screen: 'portfolio' });
      const api = await h.call<any>(alice, 'GET', '/portfolio');
      expect(api.body.data.totalValueUsdt).toBe('76000.00');
      expect(api.body.data.balances.find((b: any) => b.asset === 'JUNK')).toBeUndefined();
      expect(api.body.data.biggestHolding.asset).toBe('BTC');
      expect(api.body.data.fresh).toBe(true);
      const big = await say(alice, sid, "what's my biggest holding?");
      expect(texts(big)).toContain('Biggest holding: BTC');
    });

    it('answers balance questions per asset, including holding none', async () => {
      const sid = await h.startSession(alice);
      expect(texts(await say(alice, sid, 'how much bitcoin do I have?'))).toContain('BTC: 1 total (1 free, 0 locked)');
      expect(texts(await say(alice, sid, 'how much solana do i have'))).toContain('You hold no SOL');
    });
  });

  describe('Journey C: market questions are grounded', () => {
    it('returns verified price, change and an honest "cannot verify why" statement', async () => {
      const sid = await h.startSession(alice);
      const price = await say(alice, sid, "what's the price of ethereum");
      expect(texts(price)).toContain('ETHUSDT is 3,000.00 (testnet price');
      expect(price.evidence[0]).toMatchObject({ type: 'ticker', reference: 'ticker:ETHUSDT', value: '3000.00' });

      const change = await say(alice, sid, 'How is Bitcoin performing?');
      expect(texts(change)).toContain('+2.40% over 24h');
      expect(change.evidence[0].reference).toBe('stats:BTCUSDT');

      const why = await say(alice, sid, 'Why is Bitcoin moving today?');
      expect(why.source).toBe('deterministic');
      expect(texts(why)).toContain('FACT:');
      expect(texts(why)).toMatch(/UNVERIFIED: I cannot verify why it moved/);
      expect(texts(why)).not.toMatch(/because|due to|news says|analysts/i);
    });

    it('never fabricates values when the exchange is unavailable', async () => {
      const sid = await h.startSession(alice);
      h.fake.down = true;
      const r = await say(alice, sid, "what's the price of bitcoin");
      expect(r.response).toMatch(/unavailable/i);
      expect(r.response).not.toMatch(/\d{2},\d{3}|60000/);
    });

    it('rejects unknown assets without guessing', async () => {
      const sid = await h.startSession(alice);
      const r = await say(alice, sid, 'price of dogecoin');
      expect(r.response).toMatch(/not listed on Binance Spot Testnet/);
    });

    it('unknown input gets help, not a hallucination', async () => {
      const sid = await h.startSession(alice);
      const r = await say(alice, sid, 'tell me a joke about pirates');
      expect(r.intent).toBe('UNKNOWN');
      expect(r.response).toMatch(/Try:/);
    });
  });

  describe('Journey D: prepare, approve, execute, verify', () => {
    it('runs the full conversational trade with exchange-confirmed results', async () => {
      const sid = await h.startSession(alice);
      const prep = await say(alice, sid, 'Prepare a $50 BTC buy');
      expect(prep.uiAction.type).toBe('SHOW_PROPOSAL');
      const p = prep.uiAction.proposal;
      expect(p).toMatchObject({ symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteOrderQty: '50', environment: 'TESTNET', status: 'PENDING_APPROVAL' });
      expect(p.estimatedFee).toBeTruthy();
      expect(h.fake.createOrderCalls).toBe(0);

      // Voice "approve" only triggers the UI to approve the displayed proposal; it does not approve by itself.
      const voice = await say(alice, sid, 'approve', p.id);
      expect(voice.uiAction).toMatchObject({ type: 'APPROVE_PROPOSAL', proposalId: p.id, proposalHash: p.proposalHash });
      const still = await h.call<any>(alice, 'GET', `/trades/proposals/${p.id}`);
      expect(still.body.data.status).toBe('PENDING_APPROVAL');
      expect(h.fake.createOrderCalls).toBe(0);

      expect((await h.approve(alice, p, sid)).status).toBe(200);
      const done = await h.execute(alice, p.id);
      expect(done.status).toBe(200);
      expect(done.body.data.proposal.status).toBe('FILLED');
      expect(done.body.data.order).toMatchObject({ status: 'FILLED', confirmed: true, symbol: 'BTCUSDT', side: 'BUY', environment: 'TESTNET' });
      expect(done.body.data.order.exchangeOrderId).toBeTruthy();
      expect(done.body.data.order.averagePrice).toBe('60000');
      expect(done.body.data.order.executedQuantity).toBe('0.00083');
      expect(h.fake.balances.get('USDT')!.free).toBe('9950.2'); // spent 0.00083 * 60000 = 49.80

      const status = await say(alice, sid, 'what happened to my last order?');
      expect(texts(status)).toMatch(/Last order: BUY BTCUSDT, FILLED/);
      expect(status.evidence[0].type).toBe('order');
    });

    it('"cancel this proposal" rejects it and nothing reaches the exchange', async () => {
      const sid = await h.startSession(alice);
      const p = (await say(alice, sid, 'buy 20 usdt of btc')).uiAction.proposal;
      const r = await say(alice, sid, 'Cancel this proposal', p.id);
      expect(r.uiAction).toMatchObject({ type: 'REJECT_PROPOSAL', proposalId: p.id });
      const after = await h.call<any>(alice, 'GET', `/trades/proposals/${p.id}`);
      expect(after.body.data.status).toBe('REJECTED');
      expect((await h.approve(alice, p, sid)).status).toBe(409);
      expect(h.fake.createOrderCalls).toBe(0);
    });

    it('asks for what is missing instead of guessing, and treats "I want to trade" as no action', async () => {
      const sid = await h.startSession(alice);
      const missing = await say(alice, sid, 'buy bitcoin');
      expect(missing.requiresClarification).toBe(true);
      expect(missing.uiAction).toBeUndefined();
      const vague = await say(alice, sid, 'I want to trade bitcoin');
      expect(vague.uiAction?.type).not.toBe('SHOW_PROPOSAL');
      const rows = await h.db.select().from(tradeProposals).where(eq(tradeProposals.sessionId, sid));
      expect(rows).toHaveLength(0);
    });

    it('supports limit orders which rest on the book until cancelled', async () => {
      const sid = await h.startSession(alice);
      const p = (await say(alice, sid, 'buy $100 of btc at 50000')).uiAction.proposal;
      expect(p).toMatchObject({ orderType: 'LIMIT', price: '50000', quantity: '0.002' });
      await h.approve(alice, p, sid);
      const r = await h.execute(alice, p.id);
      expect(r.body.data.proposal.status).toBe('SUBMITTED');
      expect(r.body.data.message).toMatch(/open \(not filled yet\)/);
      const orders = await h.call<any>(alice, 'GET', '/trades/orders');
      expect(orders.body.data[0].id).toBe(r.body.data.order.id);
    });

    it('sells what you hold and refuses what you do not', async () => {
      const sid = await h.startSession(alice);
      const ok = await say(alice, sid, 'sell 0.5 btc');
      expect(ok.uiAction.proposal).toMatchObject({ side: 'SELL', quantity: '0.5' });
      const no = await say(alice, sid, 'sell 5 btc');
      expect(no.response).toMatch(/Insufficient BTC/);
    });
  });

  describe('watchlist', () => {
    it('persists per user, validates symbols and enforces uniqueness', async () => {
      const u = await h.createUser();
      const sid = await h.startSession(u);
      expect(texts(await say(u, sid, 'show my watchlist'))).toContain('BTC 60,000.00');
      expect(texts(await say(u, sid, 'add SOL to my watchlist'))).toContain('Added SOLUSDT');
      await say(u, sid, 'add sol to my watchlist'); // idempotent
      const list = await h.call<any>(u, 'GET', '/watchlist');
      expect(list.body.data.items.map((i: any) => i.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT']);
      expect(list.body.data.items[3]).toMatchObject({ price: '150.00', change24hPercent: '4.20' });
      expect((await h.call<any>(u, 'POST', '/watchlist/assets', { symbol: 'FAKEUSDT' })).status).toBe(404);
      expect((await h.call<any>(u, 'DELETE', '/watchlist/assets/ETHUSDT')).status).toBe(200);
      expect((await h.call<any>(u, 'DELETE', '/watchlist/assets/ETHUSDT')).status).toBe(404);
      // another user's watchlist is untouched
      const other = await h.call<any>(bob, 'GET', '/watchlist');
      expect(other.body.data.items.map((i: any) => i.symbol)).not.toContain('SOLUSDT');
    });
  });

  describe('Journey E: persistent memory across sessions', () => {
    it('stores only explicit preferences, recalls them in a new session, and lets the user review and delete', async () => {
      const u = await h.createUser();
      const s1 = await h.startSession(u);
      const clar = await say(u, s1, 'remember');
      expect(clar.requiresClarification).toBe(true);

      const saved = await say(u, s1, 'remember that I focus on BTC and ETH');
      expect(saved.response).toBe('Saved: I focus on BTC and ETH'); // original casing preserved
      await say(u, s1, 'my preferred quote currency is usdc');
      await say(u, s1, 'my goal is to save for a house');
      // A model-style assumption or an offhand remark is NOT stored.
      await say(u, s1, 'bitcoin is probably going up');
      const secret = await say(u, s1, 'remember that my api key is abc123');
      expect(secret.response).toMatch(/does not store keys, passwords or secrets/);

      const mems = await h.call<any>(u, 'GET', '/memory');
      const contents = mems.body.data.map((m: any) => m.content);
      expect(contents).toEqual(expect.arrayContaining(['I focus on BTC and ETH', 'Preferred quote currency is USDC', 'Goal: to save for a house']));
      expect(contents.join(' ')).not.toMatch(/abc123|going up/);
      expect(mems.body.data.every((m: any) => m.verification === 'user_confirmed' && m.source === 'user_explicit')).toBe(true);

      await say(u, s1, 'show my watchlist');
      const ended = await say(u, s1, 'end my session');
      expect(ended.data.ended).toBe(true);
      expect((await h.call<any>(u, 'POST', '/agent/message', { sessionId: s1, text: 'hi', source: 'text' })).status).toBe(409);

      // New session: relevant memory and the last summary come back.
      const s2 = await h.call<any>(u, 'POST', '/agent/sessions');
      const greeting = texts(s2.body.data.greeting);
      expect(greeting).toContain('I remember:');
      expect(greeting).toContain('focus on BTC and ETH');
      expect(greeting).toContain('Last session:');
      expect(s2.body.data.greeting.response).toMatch(/^Welcome back\./);
      expect(s2.body.data.greeting.data.preferences).toMatchObject({ preferred_quote: 'USDC' });

      // Review / correct / delete
      const first = mems.body.data[0];
      const patched = await h.call<any>(u, 'PATCH', `/memory/${first.id}`, { content: 'corrected text' });
      expect(patched.body.data.content).toBe('corrected text');
      expect((await h.call<any>(bob, 'PATCH', `/memory/${first.id}`, { content: 'hijack' })).status).toBe(404);
      expect((await h.call<any>(bob, 'DELETE', `/memory/${first.id}`)).status).toBe(404);
      expect((await h.call<any>(u, 'DELETE', `/memory/${first.id}`)).status).toBe(200);
      const after = await h.call<any>(u, 'GET', '/memory');
      expect(after.body.data.find((m: any) => m.id === first.id)).toBeUndefined();
    });

    it('a stated preferred quote currency changes how assets resolve', async () => {
      h.fake.prices.set('BTCUSDC', '60000.00');
      const u = await h.createUser();
      const sid = await h.startSession(u);
      await say(u, sid, 'my preferred quote currency is usdc');
      const r = await say(u, sid, 'price of bitcoin');
      // The fake exchange lists only USDT markets, so the honest answer is "not listed" (no silent fallback).
      expect(r.response).toMatch(/BTCUSDC is not listed/);
    });
  });

  describe('speech input', () => {
    it('reports STT as unavailable when not configured, and validates audio size', async () => {
      const r = await h.app.inject({ method: 'POST', url: '/api/v1/agent/transcribe', headers: { ...alice.headers, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(6400) });
      expect(r.statusCode).toBe(501);
      expect(r.json().error.code).toBe('STT_UNAVAILABLE');
      const tiny = await h.app.inject({ method: 'POST', url: '/api/v1/agent/transcribe', headers: { ...alice.headers, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(10) });
      expect(tiny.statusCode).toBe(400);
    });
  });

  describe('demo reset keeps exchange history', () => {
    it('closes pending proposals, resets watchlist and sessions without proposals, but never deletes orders', async () => {
      const u = await h.createUser();
      const s1 = await h.startSession(u);
      const filled = (await h.prepare(u, s1)).body.data;
      await h.approve(u, filled, s1);
      await h.execute(u, filled.id);
      const s2 = await h.startSession(u);
      const pending = (await h.prepare(u, s2)).body.data;
      const s3 = await h.startSession(u);
      await h.call<any>(u, 'POST', '/watchlist/assets', { symbol: 'SOLUSDT' });

      const r = await h.call<any>(u, 'POST', '/demo/reset');
      expect(r.status).toBe(200);
      expect(r.body.data.proposalsClosed).toBe(1);
      const orders = await h.db.select().from(exchangeOrders).where(eq(exchangeOrders.userId, u.id));
      expect(orders).toHaveLength(1);
      const [p] = await h.db.select().from(tradeProposals).where(eq(tradeProposals.id, pending.id));
      expect(p!.status).toBe('EXPIRED');
      expect(p!.failureReason).toBe('DEMO_RESET');
      const left = (await h.db.execute(sql`select id from agent_sessions where user_id = ${u.id}`)).rows.map((x: any) => x.id);
      expect(left).toContain(s1); // has a proposal => kept
      expect(left).not.toContain(s3); // empty session => removed
      const wl = await h.call<any>(u, 'GET', '/watchlist');
      expect(wl.body.data.items).toHaveLength(3); // re-seeded default
    });
  });
});
