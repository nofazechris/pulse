import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dec } from '@pulse/shared';
import { BinanceSpotTestnetAdapter } from '../src/modules/exchange/binance-adapter';
import { createHarness, HAS_DB, testEnv, type Harness, type TestUser } from './helpers';

/**
 * LIVE integration against Binance Spot TESTNET (fake money) and Neon.
 * Credentials come from apps/api/.env; nothing is printed. Orders are tiny and go through the real
 * propose -> approve -> execute flow. Run: npm run test:integration
 */
const env = testEnv();
const HAS_KEYS = Boolean(env.BINANCE_API_KEY && env.BINANCE_API_SECRET);
const adapter = new BinanceSpotTestnetAdapter({ restUrl: env.BINANCE_TESTNET_REST_URL, apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET });

describe('binance spot testnet: public market data', () => {
  it('server time is close to ours', async () => {
    const t = await adapter.getServerTime();
    expect(Math.abs(t.serverTime - Date.now())).toBeLessThan(60_000);
  });
  it('exchange info exposes BTCUSDT trading filters', async () => {
    const info = await adapter.getExchangeInfo('BTCUSDT');
    const s = info.symbols[0]!;
    expect(s).toMatchObject({ symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT' });
    expect(s.filters.tickSize).toBeTruthy();
    expect(s.filters.stepSize).toBeTruthy();
    expect(s.filters.minNotional).toBeTruthy();
    expect(s.orderTypes).toEqual(expect.arrayContaining(['LIMIT', 'MARKET']));
  });
  it('ticker, 24h stats and bulk prices are consistent and well-formed', async () => {
    const [t, s, all, many] = await Promise.all([adapter.getTicker('BTCUSDT'), adapter.get24HourStats('BTCUSDT'), adapter.getAllPrices(), adapter.get24HourStatsMany(['BTCUSDT', 'ETHUSDT'])]);
    expect(dec.gt(dec.parse(t.price), dec.ZERO)).toBe(true);
    expect(s.symbol).toBe('BTCUSDT');
    expect(dec.isDecimalString(s.priceChangePercent)).toBe(true);
    expect(all.prices.has('BTCUSDT')).toBe(true);
    expect(many.map((x) => x.symbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
  });
  it('an unknown symbol is a definitive rejection, not a crash', async () => {
    await expect(adapter.getTicker('NOPENOPE')).rejects.toMatchObject({ name: 'ExchangeRejectedError' });
  });
});

describe.skipIf(!HAS_KEYS)('binance spot testnet: signed account data', () => {
  it('returns the account with balances and a fee rate', async () => {
    const a = await adapter.getAccount();
    expect(a.canTrade).toBe(true);
    expect(a.balances.length).toBeGreaterThan(0);
    expect(dec.isDecimalString(a.takerFee)).toBe(true);
  });
  it('lists open orders', async () => {
    expect(Array.isArray(await adapter.getOpenOrders('BTCUSDT'))).toBe(true);
  });
  it('a bad signature is rejected by Binance (so signing is really being checked)', async () => {
    const wrong = new BinanceSpotTestnetAdapter({ restUrl: env.BINANCE_TESTNET_REST_URL, apiKey: env.BINANCE_API_KEY, apiSecret: 'x'.repeat(64) });
    await expect(wrong.getAccount()).rejects.toMatchObject({ name: 'ExchangeRejectedError' });
  });
});

describe.skipIf(!HAS_KEYS || !HAS_DB)('live journey: portfolio + approved testnet trades', () => {
  let h: Harness;
  let u: TestUser;
  let sid: string;

  beforeAll(async () => {
    h = await createHarness({ exchange: adapter });
    u = await h.createUser();
    sid = await h.startSession(u);
  });
  afterAll(async () => h.cleanup());

  it('portfolio is valued from real testnet balances; junk assets are excluded and counted', async () => {
    const r = await h.call<any>(u, 'GET', '/portfolio');
    expect(r.status).toBe(200);
    const p = r.body.data;
    expect(dec.gt(dec.parse(p.totalValueUsdt), dec.ZERO)).toBe(true);
    expect(p.coverage.priced).toBeGreaterThan(0);
    expect(p.coverage.priced + p.coverage.unpriced).toBe(p.coverage.total);
    expect(p.biggestHolding).toBeTruthy();
    expect(p.environment).toBe('TESTNET');
    expect(p.source).toBe('binance-spot-testnet');
    const reply = await h.call<any>(u, 'POST', '/agent/message', { sessionId: sid, text: "what's my biggest holding?", source: 'text' });
    expect(reply.body.data.response).toMatch(/Biggest holding: [A-Z0-9]+, about [\d,]+\.\d{2} USDT/);
  });

  it('market questions are answered from live testnet data', async () => {
    const r = await h.call<any>(u, 'POST', '/agent/message', { sessionId: sid, text: 'How is Bitcoin performing?', source: 'text' });
    expect(r.body.data.response).toMatch(/BTCUSDT [+-]\d+\.\d{2}% over 24h/);
    expect(r.body.data.evidence[0].reference).toBe('stats:BTCUSDT');
  });

  it('a market BUY goes prepare -> approve -> execute and the result is confirmed by Binance', async () => {
    const prep = await h.prepare(u, sid, { quoteOrderQty: '20' });
    expect(prep.status, JSON.stringify(prep.body)).toBe(200);
    const p = prep.body.data;
    expect(p).toMatchObject({ environment: 'TESTNET', status: 'PENDING_APPROVAL' });
    expect((await h.execute(u, p.id)).body.error.code).toBe('APPROVAL_REQUIRED'); // not without approval

    expect((await h.approve(u, p, sid)).status).toBe(200);
    const done = await h.execute(u, p.id);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const order = done.body.data.order;
    expect(order.confirmed).toBe(true);
    expect(order.exchangeOrderId).toMatch(/^\d+$/);
    expect(['FILLED', 'PARTIALLY_FILLED']).toContain(order.status);
    expect(dec.gt(dec.parse(order.executedQuantity), dec.ZERO)).toBe(true);
    expect(done.body.data.message).toMatch(/Bought .* BTC/);

    // Independent verification straight from the exchange, by client order id.
    const live = await adapter.getOrder('BTCUSDT', { clientOrderId: order.clientOrderId });
    expect(live.orderId).toBe(order.exchangeOrderId);
    expect(live.status).toBe(order.status);
    expect(dec.fmt(dec.parse(live.executedQty))).toBe(order.executedQuantity); // Binance pads to 8 dp, we store trimmed

    // A repeat of the same execution cannot create a second order.
    const again = await h.execute(u, p.id);
    expect(again.status).toBe(409);
    const status = await h.call<any>(u, 'GET', `/trades/orders/${order.id}`);
    expect(status.body.data.exchangeOrderId).toBe(order.exchangeOrderId);
  }, 180_000);

  it('a resting LIMIT BUY is accepted as open, then cancelled explicitly by id', async () => {
    const t = await adapter.getTicker('BTCUSDT');
    const info = (await adapter.getExchangeInfo('BTCUSDT')).symbols[0]!;
    const tick = dec.parse(info.filters.tickSize!);
    const price = dec.fmt(dec.floorToStep(dec.mul(dec.parse(t.price), dec.parse('0.6')), tick));
    const prep = await h.prepare(u, sid, { orderType: 'LIMIT', quoteOrderQty: undefined, quantity: '0.001', price });
    expect(prep.status, JSON.stringify(prep.body)).toBe(200);
    expect((await h.approve(u, prep.body.data, sid)).status).toBe(200);
    const placed = await h.execute(u, prep.body.data.id);
    expect(placed.status, JSON.stringify(placed.body)).toBe(200);
    expect(placed.body.data.proposal.status).toBe('SUBMITTED');
    expect(placed.body.data.order.status).toBe('NEW');
    expect(placed.body.data.message).toMatch(/open \(not filled yet\)/);

    const open = await adapter.getOpenOrders('BTCUSDT');
    expect(open.some((o) => o.orderId === placed.body.data.order.exchangeOrderId)).toBe(true);

    const cancelled = await h.call<any>(u, 'POST', `/trades/orders/${placed.body.data.order.id}/cancel`);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELED');
    const after = await adapter.getOrder('BTCUSDT', { orderId: placed.body.data.order.exchangeOrderId });
    expect(after.status).toBe('CANCELED');
  }, 180_000);

  it('Binance filters reject an order below the minimum notional before anything is sent', async () => {
    const r = await h.prepare(u, sid, { quoteOrderQty: '1' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('BELOW_MIN_NOTIONAL');
  });
});
