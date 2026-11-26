import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { exchangeOrders, tradeApprovals, tradePlans } from '../src/db/schema';
import { parseIntent } from '../src/modules/ai/intent-parser';
import { isTriggered, percentTrigger } from '../src/modules/trading/plans';
import { createHarness, HAS_DB, type Harness, type TestUser } from './helpers';

describe('plan rules (pure)', () => {
  it('fires on reaching or passing the level, in the stated direction only', () => {
    expect(isTriggered('BELOW', '57000', '57000')).toBe(true);
    expect(isTriggered('BELOW', '57000.01', '57000')).toBe(false);
    expect(isTriggered('ABOVE', '57000', '57000')).toBe(true);
    expect(isTriggered('ABOVE', '56999.99', '57000')).toBe(false);
  });
  it('turns a percentage into a tick-aligned level and bounds it', () => {
    expect(percentTrigger('60000', 'BELOW', '2', '0.01')).toBe('58800');
    expect(percentTrigger('60000.37', 'ABOVE', '1', '0.01')).toBe('60600.37');
    expect(() => percentTrigger('60000', 'BELOW', '0', '0.01')).toThrow();
    expect(() => percentTrigger('60000', 'BELOW', '90', '0.01')).toThrow();
  });
});

describe('plan, P&L and smart-default language', () => {
  const plan = (t: string) => parseIntent(t);
  it.each([
    ['Alert me if Bitcoin drops below 57000.', { asset: 'BTC', plan: { direction: 'BELOW', price: '57000' } }],
    ['alert me if bitcoin drops 2 percent and buy 20 dollars', { asset: 'BTC', plan: { direction: 'BELOW', percent: '2' }, side: 'BUY', quote: '20' }],
    ['If Ether rises 1% sell 0.1', { asset: 'ETH', plan: { direction: 'ABOVE', percent: '1' }, side: 'SELL' }],
    ['buy twenty dollars of bitcoin if it goes below fifty seven thousand', { asset: 'BTC', plan: { direction: 'BELOW', price: '57000' }, side: 'BUY', quote: '20' }],
    ['tell me when solana is above 150', { asset: 'SOL', plan: { direction: 'ABOVE', price: '150' } }],
    ['warn me if btc falls under 57k', { asset: 'BTC', plan: { direction: 'BELOW', price: '57000' } }],
    ['if bitcoin is below 70000 buy 25 usdt', { asset: 'BTC', plan: { direction: 'BELOW', price: '70000' }, side: 'BUY', quote: '25' }],
  ])('%s', (text, params) => {
    const p = plan(text);
    expect(p.intent).toBe('CREATE_PLAN');
    expect(p.params).toMatchObject(params);
  });

  it('does not confuse questions or instant orders with plans', () => {
    expect(plan('buy 20 usdt of btc').intent).toBe('PREPARE_TRADE');
    expect(plan('How is Bitcoin doing today?').intent).not.toBe('CREATE_PLAN');
    expect(plan('Should I buy if bitcoin drops below 50000?').intent).toBe('ASK_FINANCIAL_QUESTION');
    expect(plan('add bitcoin to my watchlist').intent).toBe('ADD_WATCHLIST_ASSET');
    expect(plan('alert me if bitcoin drops').params.missing).toContain('amount');
  });
  it('lists and cancels plans, asks about P&L, and learns a usual buy', () => {
    expect(plan('show my alerts').intent).toBe('GET_PLANS');
    expect(plan('what are my plans?').intent).toBe('GET_PLANS');
    expect(plan('cancel my bitcoin alert').intent).toBe('CANCEL_PLAN');
    expect(plan('cancel all plans').params.allPlans).toBe(true);
    expect(plan('Cancel this proposal.').intent).toBe('REJECT_TRADE');
    for (const t of ['How is my session?', "what's my P&L", 'how am i doing', 'session performance']) expect(plan(t).intent, t).toBe('GET_SESSION_PNL');
    expect(plan('my usual buy is twenty five dollars').params.memory?.preference).toEqual({ key: 'default_buy_usdt', value: '25' });
  });
});

describe.skipIf(!HAS_DB)('trade plans, session P&L and smart defaults', () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => h.cleanup());
  beforeEach(() => h.resetFake());

  const say = async (u: TestUser, sessionId: string, text: string) =>
    (await h.call<any>(u, 'POST', '/agent/message', { sessionId, text, source: 'voice' })).body.data;
  const check = async (u: TestUser, sessionId: string) => (await h.call<any>(u, 'POST', '/plans/check', { sessionId })).body.data;
  const price = (p: string) => { h.fake.prices.set('BTCUSDT', p); h.services.market.invalidate(); };
  const user = async () => { const u = await h.createUser(); return { u, sid: await h.startSession(u) }; };

  it('a fired plan only PREPARES an order: it needs the same approval, and it fires once', async () => {
    const { u, sid } = await user();
    const armed = await say(u, sid, 'alert me if bitcoin drops 2 percent and buy 20 dollars');
    expect(armed.intent).toBe('CREATE_PLAN');
    expect(armed.response).toMatch(/Plan armed: BTC below 58,800.00.*once you approve/);
    expect(await check(u, sid)).toEqual({ alerts: [], armed: 1 });

    price('58000.00');
    const [a, b] = await Promise.all([check(u, sid), check(u, sid)]); // concurrent checks
    const alerts = [...a.alerts, ...b.alerts];
    expect(alerts).toHaveLength(1);
    const alert = alerts[0];
    expect(alert.plan).toMatchObject({ status: 'TRIGGERED', observedPrice: '58000' });
    expect(alert.proposal).toMatchObject({ status: 'PENDING_APPROVAL', side: 'BUY', quoteOrderQty: '20', environment: 'TESTNET' });
    expect(alert.proposal.warnings[0]).toBe('PLAN: BTC below 58,800.00 reached');
    expect(h.fake.createOrderCalls).toBe(0);
    expect(await h.db.select().from(tradeApprovals).where(eq(tradeApprovals.userId, u.id))).toHaveLength(0);
    expect((await h.execute(u, alert.proposal.id)).body.error.code).toBe('APPROVAL_REQUIRED');
    expect((await check(u, sid)).alerts).toHaveLength(0); // one shot
    // and the ordinary approval path works from there
    await h.approve(u, alert.proposal, sid);
    expect((await h.execute(u, alert.proposal.id)).body.data.proposal.status).toBe('FILLED');
    expect(await h.db.select().from(exchangeOrders).where(eq(exchangeOrders.userId, u.id))).toHaveLength(1);
  });

  it('never replaces a proposal the wearer is still deciding on', async () => {
    const { u, sid } = await user();
    await say(u, sid, 'if bitcoin is below 59000 buy 20 usdt');
    const mine = (await h.prepare(u, sid, { quoteOrderQty: '30' })).body.data;
    price('58000.00');
    expect((await check(u, sid)).alerts).toHaveLength(0); // held
    await h.call(u, 'POST', `/trades/proposals/${mine.id}/reject`, { sessionId: sid });
    expect((await check(u, sid)).alerts).toHaveLength(1); // now it fires
  });

  it('an alert without an action carries no order, and a plan that cannot be prepared says why', async () => {
    const { u, sid } = await user();
    await say(u, sid, 'tell me when bitcoin is above 61000');
    price('61500.00');
    const r = await check(u, sid);
    expect(r.alerts[0]).toMatchObject({ proposal: null });
    expect(r.alerts[0].message).toMatch(/Plan fired: BTC above 61,000.00. Now 61,500.00/);

    await say(u, sid, 'if bitcoin is below 70000 buy 999999 usdt');
    const broke = await check(u, sid);
    expect(broke.alerts[0].proposal).toBeNull();
    expect(broke.alerts[0].message).toMatch(/Could not prepare the order: Insufficient USDT/);
    expect(h.fake.createOrderCalls).toBe(0);
  });

  it('does not fire while the exchange is unreachable, and keeps the plan armed', async () => {
    const { u, sid } = await user();
    await say(u, sid, 'alert me if bitcoin drops below 59000');
    h.fake.down = true;
    h.services.market.invalidate();
    expect((await h.call<any>(u, 'POST', '/plans/check', { sessionId: sid })).status).toBe(503);
    const [row] = await h.db.select().from(tradePlans).where(eq(tradePlans.userId, u.id));
    expect(row!.status).toBe('ARMED');
  });

  it('lists, cancels, expires, limits and protects plans per user', async () => {
    const { u, sid } = await user();
    const other = await user();
    await say(u, sid, 'alert me if bitcoin drops 5 percent');
    await say(u, sid, 'alert me if ether rises 5 percent');
    expect((await say(u, sid, 'show my alerts')).sections.map((s: any) => s.text)).toEqual(['BTC below 57,000.00', 'ETH above 3,150.00']);
    expect((await say(u, sid, 'cancel my alert')).requiresClarification).toBe(true);
    const id = (await h.call<any>(u, 'GET', '/plans')).body.data[0].id;
    expect((await h.call<any>(other.u, 'DELETE', `/plans/${id}`)).status).toBe(404);
    expect((await say(u, sid, 'cancel my bitcoin alert')).response).toBe('Cancelled: BTC below 57,000.00.');
    await h.db.update(tradePlans).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(tradePlans.userId, u.id));
    expect((await h.call<any>(u, 'GET', '/plans')).body.data).toEqual([]);
    for (let i = 1; i <= 5; i++) await say(u, sid, `alert me if bitcoin drops ${i} percent`);
    expect((await say(u, sid, 'alert me if bitcoin drops 9 percent')).response).toMatch(/already have 5 plans/);
    expect((await h.call<any>(other.u, 'POST', '/plans/check', { sessionId: sid })).status).toBe(404); // not their session
  });

  it('reports session P&L from the value at session start', async () => {
    const { u, sid } = await user(); // 76,000.00 at start (1 BTC, 2 ETH, 10,000 USDT)
    price('61000.00');
    const r = await say(u, sid, 'how is my session?');
    expect(r.intent).toBe('GET_SESSION_PNL');
    expect(r.sections[0].text).toBe('Session P&L: +1,000.00 USDT (+1.31%).');
    expect(r.sections[1].text).toContain('From 76,000.00 to 77,000.00 USDT.');
    price('59000.00');
    expect((await say(u, sid, "what's my p&l")).sections[0].text).toBe('Session P&L: -1,000.00 USDT (-1.31%).');
  });

  it('uses a smart default amount only for buys, labelled on the proposal', async () => {
    const { u, sid } = await user();
    expect((await say(u, sid, 'buy bitcoin')).requiresClarification).toBe(true); // nothing to default from yet
    await say(u, sid, 'my usual buy is 25 dollars');
    const p = (await say(u, sid, 'buy bitcoin')).uiAction.proposal;
    expect(p).toMatchObject({ quoteOrderQty: '25', status: 'PENDING_APPROVAL' });
    expect(p.warnings[0]).toBe('SMART DEFAULT: your usual 25 USDT');
    expect((await say(u, sid, 'sell bitcoin')).requiresClarification).toBe(true); // never guess a sell size

    const second = await user();
    const first = (await h.prepare(second.u, second.sid, { quoteOrderQty: '40' })).body.data;
    await h.approve(second.u, first, second.sid);
    await h.execute(second.u, first.id);
    const again = (await say(second.u, second.sid, 'buy bitcoin')).uiAction.proposal;
    expect(again.quoteOrderQty).toBe('40');
    expect(again.warnings[0]).toBe('SMART DEFAULT: your last 40 USDT');
  });
});
