import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { exchangeOrders, tradePlans, tradeProposals } from '../src/db/schema';
import { parseIntent } from '../src/modules/ai/intent-parser';
import { validateAiIntent } from '../src/modules/ai/validate';
import { createHarness, HAS_DB, type Harness, type TestUser } from './helpers';

describe('sell-share and open-order language', () => {
  it.each([
    ['Sell half my bitcoin.', 'BTC', '0.5'],
    ['sell a quarter of my ETH', 'ETH', '0.25'],
    ['sell all my sol', 'SOL', '1'],
    ['sell twenty five percent of my bitcoin', 'BTC', '0.25'],
    ['sell 10% of my eth', 'ETH', '0.1'],
  ])('%s', (text, asset, fraction) => {
    const p = parseIntent(text);
    expect(p.intent).toBe('PREPARE_TRADE');
    expect(p.params).toMatchObject({ side: 'SELL', asset, fraction });
    expect(p.params.missing).toBeUndefined();
    expect(p.params.quantity).toBeUndefined();
  });

  it('asks rather than guesses, and leaves exact amounts alone', () => {
    expect(parseIntent('sell half a bitcoin').params.fraction).toBeUndefined();
    expect(parseIntent('sell half a bitcoin').params.missing).toContain('amount');
    expect(parseIntent('sell 250 percent of my bitcoin').params.fraction).toBeUndefined();
    expect(parseIntent('sell 0.1 eth').params).toMatchObject({ quantity: '0.1' });
    expect(parseIntent('buy half my bitcoin').params.fraction).toBeUndefined();
  });

  it('puts a share into a sell plan', () => {
    for (const t of ['if bitcoin rises 2 percent sell half', 'sell half my bitcoin if it rises 2 percent']) {
      const p = parseIntent(t);
      expect(p.intent, t).toBe('CREATE_PLAN');
      expect(p.params, t).toMatchObject({ asset: 'BTC', side: 'SELL', fraction: '0.5', plan: { direction: 'ABOVE', percent: '2' } });
    }
  });

  it('separates listing, cancelling an order, rejecting a proposal and cancelling a plan', () => {
    for (const t of ['show my open orders', 'any pending orders?', 'show my orders']) expect(parseIntent(t).intent, t).toBe('GET_OPEN_ORDERS');
    for (const t of ['cancel my order', 'Cancel my open order.', 'pulse, cancel the bitcoin buy order']) expect(parseIntent(t).intent, t).toBe('CANCEL_ORDER');
    expect(parseIntent('cancel my bitcoin buy order').params.asset).toBe('BTC');
    expect(parseIntent('cancel the order').intent).toBe('REJECT_TRADE');
    expect(parseIntent('cancel all plans').intent).toBe('CANCEL_PLAN');
    expect(parseIntent('what happened to my last order').intent).toBe('GET_ORDER_STATUS');
    expect(parseIntent('should I cancel my order?').intent).toBe('ASK_FINANCIAL_QUESTION');
  });

  it('never lets a model ask for a cancellation', () => {
    expect(validateAiIntent({ intent: 'CANCEL_ORDER', params: {} })?.intent).toBe('UNKNOWN');
  });
});

describe.skipIf(!HAS_DB)('server-side plan watching, selling a share, open orders', () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => h.cleanup());
  beforeEach(() => h.resetFake());

  const say = async (u: TestUser, sessionId: string, text: string, displayedProposalId?: string) =>
    (await h.call<any>(u, 'POST', '/agent/message', { sessionId, text, source: 'voice', ...(displayedProposalId ? { displayedProposalId } : {}) })).body.data;
  const check = async (u: TestUser, sessionId: string) => (await h.call<any>(u, 'POST', '/plans/check', { sessionId })).body.data;
  const price = (p: string) => { h.fake.prices.set('BTCUSDT', p); h.services.market.invalidate(); };
  const user = async () => { const u = await h.createUser(); return { u, sid: await h.startSession(u) }; };
  const watch = (u: TestUser) => h.services.plans.recordHits({ userId: u.id });

  it('"sell half" becomes an exact quantity that needs the usual approval', async () => {
    const { u, sid } = await user(); // 1 BTC free
    const r = await say(u, sid, 'sell half my bitcoin');
    const p = r.uiAction.proposal;
    expect(p).toMatchObject({ side: 'SELL', quantity: '0.5', status: 'PENDING_APPROVAL' });
    expect(p.warnings[0]).toMatch(/^HALF YOUR 1(\.0+)? BTC$/);
    expect(h.fake.createOrderCalls).toBe(0);
    await h.approve(u, p, sid);
    expect((await h.execute(u, p.id)).body.data.proposal.status).toBe('FILLED');
    expect(h.fake.balances.get('BTC')!.free).toBe('0.5');
    expect((await say(u, sid, 'sell all my sol')).response).toMatch(/no SOL free to sell/);
  });

  it('a sell plan sizes its share from the balance at the moment it fires', async () => {
    const { u, sid } = await user();
    expect((await say(u, sid, 'if bitcoin rises 2 percent sell half')).response).toMatch(/Then sell half your BTC, once you approve/);
    h.fake.balances.set('BTC', { free: '0.4', locked: '0' });
    h.services.portfolio.invalidate();
    price('62000.00');
    const alert = (await check(u, sid)).alerts[0];
    expect(alert.proposal).toMatchObject({ side: 'SELL', quantity: '0.2', status: 'PENDING_APPROVAL' });
  });

  it('the watcher records a hit while the app is closed, and never fires or trades', async () => {
    const { u, sid } = await user();
    await say(u, sid, 'alert me if bitcoin drops below 59000 and buy 20 dollars');
    expect(await watch(u)).toBe(0); // level not reached
    price('58000.00');
    expect(await watch(u)).toBe(1);
    expect(await watch(u)).toBe(0); // recorded once
    const [row] = await h.db.select().from(tradePlans).where(eq(tradePlans.userId, u.id));
    expect(row).toMatchObject({ status: 'ARMED' });
    expect(row!.hitAt).not.toBeNull();
    expect(await h.db.select().from(tradeProposals).where(eq(tradeProposals.userId, u.id))).toHaveLength(0);
    expect(h.fake.createOrderCalls).toBe(0);

    price('60500.00'); // moved back before the wearer returned
    const [alert] = (await check(u, sid)).alerts;
    expect(alert).toMatchObject({ proposal: null, plan: { status: 'TRIGGERED', hitPrice: '58000' } });
    expect(alert.note).toBe('Hit 58,000.00 earlier, then moved back. No order.');
    expect((await check(u, sid)).alerts).toHaveLength(0);
  });

  it('a hit that still holds when the wearer returns prepares the order for approval', async () => {
    const { u, sid } = await user();
    await say(u, sid, 'alert me if bitcoin drops below 59000 and buy 20 dollars');
    price('58000.00');
    await watch(u);
    const [alert] = (await check(u, sid)).alerts;
    expect(alert.proposal).toMatchObject({ side: 'BUY', quoteOrderQty: '20', status: 'PENDING_APPROVAL' });
    expect(h.fake.createOrderCalls).toBe(0);
  });

  it('a hit is still reported after the plan expires, but offers no order', async () => {
    const { u, sid } = await user();
    await say(u, sid, 'alert me if bitcoin drops below 59000 and buy 20 dollars');
    price('58000.00');
    await watch(u);
    await h.db.update(tradePlans).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(tradePlans.userId, u.id));
    const [alert] = (await check(u, sid)).alerts; // the price still matches, but the 24 hours are over
    expect(alert.proposal).toBeNull();
    expect(alert.note).toBe('Hit 58,000.00 earlier. Plan expired. No order.');
    expect((await check(u, sid)).armed).toBe(0);
  });

  const restingBuy = async (u: TestUser, sid: string) => {
    const p = (await say(u, sid, 'buy 20 dollars of bitcoin at 50000')).uiAction.proposal;
    expect(p).toMatchObject({ orderType: 'LIMIT', price: '50000' });
    await h.approve(u, p, sid);
    expect((await h.execute(u, p.id)).body.data.order.status).toBe('NEW');
  };

  it('lists open orders; a voice "cancel" only asks, and the confirmed call cancels that order', async () => {
    const { u, sid } = await user();
    expect((await say(u, sid, 'show my open orders')).sections[0].text).toBe('No open orders.');
    await restingBuy(u, sid);
    expect((await say(u, sid, 'show my open orders')).sections[0].text).toMatch(/^BUY [\d.]+ BTC at 50,000\.00$/);

    const asked = await say(u, sid, 'cancel my order');
    expect(asked.uiAction).toMatchObject({ type: 'CONFIRM_CANCEL', price: '50000', openCount: 1 });
    expect([...h.fake.orders.values()][0]!.status).toBe('NEW'); // nothing cancelled by voice

    const other = await user();
    const orderId = asked.uiAction.order.id;
    expect((await h.call<any>(other.u, 'POST', `/trades/orders/${orderId}/cancel`)).status).toBe(404);
    expect((await say(other.u, other.sid, 'cancel my order')).response).toBe('No open order to cancel.');

    expect((await h.call<any>(u, 'POST', `/trades/orders/${orderId}/cancel`)).body.data.status).toBe('CANCELED');
    expect((await say(u, sid, 'show my open orders')).sections[0].text).toBe('No open orders.');
    expect((await h.call<any>(u, 'POST', `/trades/orders/${orderId}/cancel`)).body.error.code).toBe('ORDER_NOT_OPEN');
  });

  it('a cancelled order reads as cancelled, never as failed', async () => {
    const { u, sid } = await user();
    await restingBuy(u, sid);
    const asked = await say(u, sid, 'cancel my order');
    await h.call(u, 'POST', `/trades/orders/${asked.uiAction.order.id}/cancel`);
    expect((await say(u, sid, 'how is my session?')).sections[2].text).toBe('Last trade: BUY BTCUSDT CANCELLED.');
    const ended = await say(u, sid, 'end my session');
    expect(ended.response).toContain('Trades: 1 cancelled.');
    expect(ended.response).not.toMatch(/failed/i);
  });

  it('an order that filled meanwhile is not offered for cancelling', async () => {
    const { u, sid } = await user();
    await restingBuy(u, sid);
    for (const [k, v] of h.fake.orders) h.fake.orders.set(k, { ...v, status: 'FILLED', executedQty: v.origQty, averagePrice: '50000' });
    expect((await say(u, sid, 'cancel my order')).response).toBe('No open order to cancel.');
    const [row] = await h.db.select().from(exchangeOrders).where(eq(exchangeOrders.userId, u.id));
    expect(row!.status).toBe('FILLED');
  });

  it('while a proposal is on the lens, "cancel the bitcoin order" rejects that proposal only', async () => {
    const { u, sid } = await user();
    await restingBuy(u, sid);
    const p = (await say(u, sid, 'buy 30 dollars of bitcoin')).uiAction.proposal;
    const r = await say(u, sid, 'cancel the bitcoin order', p.id);
    expect(r.uiAction).toMatchObject({ type: 'REJECT_PROPOSAL', proposalId: p.id });
    expect([...h.fake.orders.values()][0]!.status).toBe('NEW');
  });
});
