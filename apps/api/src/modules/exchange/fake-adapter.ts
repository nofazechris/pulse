import { randomUUID } from 'node:crypto';
import { dec } from '@pulse/shared';
import {
  ExchangeRejectedError, ExchangeUnavailableError, BINANCE_ORDER_NOT_FOUND,
  type ExchangeAccount, type ExchangeAdapter, type ExchangeInfo, type ExchangeOrder, type OrderRef,
  type RawMarketStats, type ServerTime, type SymbolInfo, type TickerData, type ValidatedOrderRequest,
} from './types';

export type FakeFailure = 'reject' | 'timeout-accepted' | 'timeout-lost' | 'unavailable' | null;

/**
 * Deterministic in-memory exchange used by unit/safety tests and by the explicit DEMO mode.
 * It is never selected silently: the server only uses it when DEMO_MODE=true, and every response
 * is then labelled DEMO.
 */
export class FakeExchangeAdapter implements ExchangeAdapter {
  readonly name = 'demo-exchange';
  prices = new Map<string, string>([
    ['BTCUSDT', '60000.00'], ['ETHUSDT', '3000.00'], ['BNBUSDT', '600.00'], ['SOLUSDT', '150.00'],
  ]);
  changes = new Map<string, string>([['BTCUSDT', '2.40'], ['ETHUSDT', '-1.10'], ['BNBUSDT', '0.50'], ['SOLUSDT', '4.20']]);
  balances = new Map<string, { free: string; locked: string }>([
    ['USDT', { free: '10000', locked: '0' }], ['BTC', { free: '1', locked: '0' }], ['ETH', { free: '2', locked: '0' }],
  ]);
  orders = new Map<string, ExchangeOrder>();
  createOrderCalls = 0;
  failure: FakeFailure = null;
  down = false;
  takerFee = '0.001';

  private symbols: SymbolInfo[] = ['BTC', 'ETH', 'BNB', 'SOL'].map((base) => ({
    symbol: `${base}USDT`, status: 'TRADING', baseAsset: base, quoteAsset: 'USDT', orderTypes: ['LIMIT', 'MARKET'],
    filters: {
      tickSize: '0.01', minPrice: '0.01', maxPrice: '1000000',
      stepSize: base === 'BTC' ? '0.00001' : '0.001', minQty: base === 'BTC' ? '0.00001' : '0.001', maxQty: '9000',
      marketStepSize: base === 'BTC' ? '0.00001' : '0.001', marketMinQty: base === 'BTC' ? '0.00001' : '0.001', marketMaxQty: '1000',
      minNotional: '5', applyMinToMarket: true,
    },
  }));

  private guard() {
    if (this.down) throw new ExchangeUnavailableError('Demo exchange is down', false);
  }

  async getServerTime(): Promise<ServerTime> {
    this.guard();
    return { serverTime: Date.now() };
  }
  async getExchangeInfo(symbol?: string): Promise<ExchangeInfo> {
    this.guard();
    return { symbols: symbol ? this.symbols.filter((s) => s.symbol === symbol) : this.symbols, fetchedAt: Date.now() };
  }
  async getTicker(symbol: string): Promise<TickerData> {
    this.guard();
    const price = this.prices.get(symbol);
    if (!price) throw new ExchangeRejectedError(400, -1121, 'Invalid symbol.');
    return { symbol, price, fetchedAt: Date.now() };
  }
  async getAllPrices() {
    this.guard();
    return { prices: new Map(this.prices), fetchedAt: Date.now() };
  }
  async get24HourStats(symbol: string): Promise<RawMarketStats> {
    const t = await this.getTicker(symbol);
    const p = dec.parse(t.price);
    return {
      symbol, lastPrice: t.price, priceChangePercent: this.changes.get(symbol) ?? '0',
      highPrice: dec.fmt(dec.mul(p, dec.parse('1.02'))), lowPrice: dec.fmt(dec.mul(p, dec.parse('0.98'))),
      volume: '1000', quoteVolume: '60000000', fetchedAt: Date.now(),
    };
  }
  async get24HourStatsMany(symbols: string[]): Promise<RawMarketStats[]> {
    return Promise.all(symbols.map((s) => this.get24HourStats(s)));
  }
  async getAccount(): Promise<ExchangeAccount> {
    this.guard();
    return {
      canTrade: true, takerFee: this.takerFee, updateTime: Date.now(), fetchedAt: Date.now(),
      balances: [...this.balances].map(([asset, b]) => ({ asset, ...b })),
    };
  }
  async getOpenOrders(symbol?: string): Promise<ExchangeOrder[]> {
    this.guard();
    return [...this.orders.values()].filter((o) => ['NEW', 'PARTIALLY_FILLED'].includes(o.status) && (!symbol || o.symbol === symbol));
  }
  /** Test switch: order lookups fail (simulates not being able to verify an uncertain order). */
  getOrderDown = false;

  async getOrder(symbol: string, ref: OrderRef): Promise<ExchangeOrder> {
    this.guard();
    if (this.getOrderDown) throw new ExchangeUnavailableError('Order lookup unavailable');
    const found = [...this.orders.values()].find(
      (o) => o.symbol === symbol && (ref.orderId ? o.orderId === ref.orderId : o.clientOrderId === ref.clientOrderId),
    );
    if (!found) throw new ExchangeRejectedError(400, BINANCE_ORDER_NOT_FOUND, 'Order does not exist.');
    return { ...found, fetchedAt: Date.now() };
  }

  async createOrder(r: ValidatedOrderRequest): Promise<ExchangeOrder> {
    this.guard();
    this.createOrderCalls++;
    if (this.failure === 'unavailable') throw new ExchangeUnavailableError('Demo exchange unavailable');
    if (this.failure === 'reject') throw new ExchangeRejectedError(400, -2010, 'Account has insufficient balance for requested action.');
    if (this.failure === 'timeout-lost') throw new ExchangeUnavailableError('Binance Testnet request timed out');

    const info = this.symbols.find((s) => s.symbol === r.symbol)!;
    const market = dec.parse(this.prices.get(r.symbol)!);
    const fillPrice = r.type === 'LIMIT' ? dec.parse(r.price!) : market;
    const qty = r.quantity ? dec.parse(r.quantity) : dec.floorToStep(dec.div(dec.parse(r.quoteOrderQty!), fillPrice), dec.parse(info.filters.stepSize!));
    const quote = dec.mul(qty, fillPrice);
    const marketable = r.type === 'MARKET' || (r.side === 'BUY' ? dec.gte(fillPrice, market) : dec.lte(fillPrice, market));

    const bal = (a: string) => this.balances.get(a) ?? { free: '0', locked: '0' };
    const baseB = bal(info.baseAsset);
    const quoteB = bal(info.quoteAsset);
    if (marketable) {
      if (r.side === 'BUY') {
        this.balances.set(info.quoteAsset, { ...quoteB, free: dec.fmt(dec.sub(dec.parse(quoteB.free), quote)) });
        this.balances.set(info.baseAsset, { ...baseB, free: dec.fmt(dec.add(dec.parse(baseB.free), qty)) });
      } else {
        this.balances.set(info.baseAsset, { ...baseB, free: dec.fmt(dec.sub(dec.parse(baseB.free), qty)) });
        this.balances.set(info.quoteAsset, { ...quoteB, free: dec.fmt(dec.add(dec.parse(quoteB.free), quote)) });
      }
    }
    const order: ExchangeOrder = {
      orderId: String(Math.floor(Math.random() * 1e9)), clientOrderId: r.newClientOrderId, symbol: r.symbol, side: r.side,
      type: r.type, status: marketable ? 'FILLED' : 'NEW', price: r.price ?? '0', origQty: dec.fmt(qty),
      executedQty: marketable ? dec.fmt(qty) : '0', cummulativeQuoteQty: marketable ? dec.fmt(quote) : '0',
      averagePrice: marketable ? dec.fmtFixed(fillPrice, 8) : null, time: Date.now(), fetchedAt: Date.now(),
    };
    this.orders.set(randomUUID(), order);
    if (this.failure === 'timeout-accepted') throw new ExchangeUnavailableError('Binance Testnet request timed out');
    return order;
  }

  async cancelOrder(symbol: string, ref: OrderRef): Promise<ExchangeOrder> {
    const o = await this.getOrder(symbol, ref);
    if (!['NEW', 'PARTIALLY_FILLED'].includes(o.status)) {
      throw new ExchangeRejectedError(400, -2011, 'Unknown order sent.');
    }
    for (const [k, v] of this.orders) if (v.orderId === o.orderId) this.orders.set(k, { ...v, status: 'CANCELED' });
    return { ...o, status: 'CANCELED' };
  }
}
