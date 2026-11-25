import { z } from 'zod';
import { dec } from '@pulse/shared';
import { BinanceClient, type BinanceClientOptions } from './binance-client';
import { assertTestnetRestUrl } from './guard';
import {
  ExchangeUnavailableError,
  type ExchangeAccount, type ExchangeAdapter, type ExchangeInfo, type ExchangeOrder,
  type OrderRef, type RawMarketStats, type ServerTime, type SymbolFilters, type SymbolInfo,
  type TickerData, type ValidatedOrderRequest,
} from './types';

const num = z.union([z.string(), z.number()]).transform(String);

const filterSchema = z.object({ filterType: z.string() }).passthrough();
const symbolSchema = z.object({
  symbol: z.string(),
  status: z.string(),
  baseAsset: z.string(),
  quoteAsset: z.string(),
  orderTypes: z.array(z.string()).default([]),
  filters: z.array(filterSchema).default([]),
});
const exchangeInfoSchema = z.object({ symbols: z.array(symbolSchema) });

const tickerSchema = z.object({ symbol: z.string(), price: z.string() });
const stats24Schema = z.object({
  symbol: z.string(),
  lastPrice: z.string(),
  priceChangePercent: z.string(),
  highPrice: z.string(),
  lowPrice: z.string(),
  volume: z.string(),
  quoteVolume: z.string(),
});
const accountSchema = z.object({
  canTrade: z.boolean(),
  updateTime: z.number(),
  takerCommission: z.number().optional(),
  commissionRates: z.object({ taker: z.string() }).partial().optional(),
  balances: z.array(z.object({ asset: z.string(), free: z.string(), locked: z.string() })),
});
const orderSchema = z.object({
  symbol: z.string(),
  orderId: num,
  clientOrderId: z.string(),
  price: z.string().default('0'),
  origQty: z.string().default('0'),
  executedQty: z.string().default('0'),
  cummulativeQuoteQty: z.string().default('0'),
  status: z.string(),
  type: z.string(),
  side: z.enum(['BUY', 'SELL']),
  time: z.number().optional(),
  transactTime: z.number().optional(),
  workingTime: z.number().optional(),
});

function parseFilters(raw: z.infer<typeof filterSchema>[]): SymbolFilters {
  const f: SymbolFilters = { applyMinToMarket: true };
  for (const x of raw as Array<Record<string, unknown>>) {
    const s = (k: string) => (typeof x[k] === 'string' ? (x[k] as string) : undefined);
    switch (x.filterType) {
      case 'PRICE_FILTER':
        Object.assign(f, { tickSize: s('tickSize'), minPrice: s('minPrice'), maxPrice: s('maxPrice') });
        break;
      case 'LOT_SIZE':
        Object.assign(f, { stepSize: s('stepSize'), minQty: s('minQty'), maxQty: s('maxQty') });
        break;
      case 'MARKET_LOT_SIZE':
        Object.assign(f, { marketStepSize: s('stepSize'), marketMinQty: s('minQty'), marketMaxQty: s('maxQty') });
        break;
      case 'NOTIONAL':
        Object.assign(f, { minNotional: s('minNotional'), maxNotional: s('maxNotional') });
        f.applyMinToMarket = x.applyMinToMarket !== false;
        break;
      case 'MIN_NOTIONAL':
        f.minNotional ??= s('minNotional');
        f.applyMinToMarket = x.applyToMarket !== false;
        break;
      default:
        break;
    }
  }
  return f;
}

function toSymbolInfo(s: z.infer<typeof symbolSchema>): SymbolInfo {
  return {
    symbol: s.symbol, status: s.status, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset,
    orderTypes: s.orderTypes, filters: parseFilters(s.filters),
  };
}

function toOrder(raw: unknown): ExchangeOrder {
  const o = orderSchema.parse(raw);
  const executed = dec.parse(o.executedQty);
  const average =
    dec.gt(executed, dec.ZERO) ? dec.fmtFixed(dec.div(dec.parse(o.cummulativeQuoteQty), executed), 8) : null;
  return {
    orderId: o.orderId, clientOrderId: o.clientOrderId, symbol: o.symbol, side: o.side, type: o.type,
    status: o.status, price: o.price, origQty: o.origQty, executedQty: o.executedQty,
    cummulativeQuoteQty: o.cummulativeQuoteQty, averagePrice: average,
    time: o.transactTime ?? o.time ?? o.workingTime ?? Date.now(), fetchedAt: Date.now(),
  };
}

function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new ExchangeUnavailableError(`Unexpected ${what} response shape from exchange`, false);
  return r.data;
}

export class BinanceSpotTestnetAdapter implements ExchangeAdapter {
  readonly name = 'binance-spot-testnet';
  private readonly client: BinanceClient;

  constructor(opts: BinanceClientOptions) {
    assertTestnetRestUrl(opts.restUrl);
    this.client = new BinanceClient(opts);
  }

  get hasCredentials(): boolean {
    return this.client.hasCredentials;
  }

  async getServerTime(): Promise<ServerTime> {
    return parseOrThrow(z.object({ serverTime: z.number() }), await this.client.publicGet('/v3/time'), 'time');
  }

  async getExchangeInfo(symbol?: string): Promise<ExchangeInfo> {
    const raw = await this.client.publicGet('/v3/exchangeInfo', symbol ? { symbol } : {});
    const info = parseOrThrow(exchangeInfoSchema, raw, 'exchangeInfo');
    return { symbols: info.symbols.map(toSymbolInfo), fetchedAt: Date.now() };
  }

  async getTicker(symbol: string): Promise<TickerData> {
    const t = parseOrThrow(tickerSchema, await this.client.publicGet('/v3/ticker/price', { symbol }), 'ticker');
    return { symbol: t.symbol, price: t.price, fetchedAt: Date.now() };
  }

  async getAllPrices() {
    const list = parseOrThrow(z.array(tickerSchema), await this.client.publicGet('/v3/ticker/price'), 'prices');
    return { prices: new Map(list.map((t) => [t.symbol, t.price])), fetchedAt: Date.now() };
  }

  async get24HourStats(symbol: string): Promise<RawMarketStats> {
    const s = parseOrThrow(stats24Schema, await this.client.publicGet('/v3/ticker/24hr', { symbol }), '24hr ticker');
    return { ...s, fetchedAt: Date.now() };
  }

  async get24HourStatsMany(symbols: string[]): Promise<RawMarketStats[]> {
    if (symbols.length === 0) return [];
    const raw = await this.client.publicGet('/v3/ticker/24hr', { symbols: JSON.stringify(symbols) });
    return parseOrThrow(z.array(stats24Schema), raw, '24hr tickers').map((s) => ({ ...s, fetchedAt: Date.now() }));
  }

  async getAccount(): Promise<ExchangeAccount> {
    const a = parseOrThrow(accountSchema, await this.client.signedGet('/v3/account', { omitZeroBalances: 'true' }), 'account');
    const takerFee =
      a.commissionRates?.taker ?? (a.takerCommission !== undefined ? dec.fmt(dec.div(dec.parse(String(a.takerCommission)), dec.parse('10000'))) : '0.001');
    return {
      canTrade: a.canTrade, updateTime: a.updateTime, takerFee, fetchedAt: Date.now(),
      balances: a.balances.filter((b) => dec.gt(dec.parse(b.free), dec.ZERO) || dec.gt(dec.parse(b.locked), dec.ZERO)),
    };
  }

  async getOpenOrders(symbol?: string): Promise<ExchangeOrder[]> {
    const raw = await this.client.signedGet('/v3/openOrders', symbol ? { symbol } : {});
    return parseOrThrow(z.array(z.unknown()), raw, 'openOrders').map(toOrder);
  }

  async getOrder(symbol: string, ref: OrderRef): Promise<ExchangeOrder> {
    return toOrder(
      await this.client.signedGet('/v3/order', { symbol, orderId: ref.orderId, origClientOrderId: ref.clientOrderId }),
    );
  }

  async createOrder(r: ValidatedOrderRequest): Promise<ExchangeOrder> {
    const raw = await this.client.signedWrite('POST', '/v3/order', {
      symbol: r.symbol,
      side: r.side,
      type: r.type,
      quantity: r.quantity,
      quoteOrderQty: r.quoteOrderQty,
      price: r.price,
      timeInForce: r.type === 'LIMIT' ? 'GTC' : undefined,
      newClientOrderId: r.newClientOrderId,
      newOrderRespType: 'FULL',
    });
    // FULL response carries fills; executedQty/cummulativeQuoteQty are authoritative.
    return toOrder(raw);
  }

  async cancelOrder(symbol: string, ref: OrderRef): Promise<ExchangeOrder> {
    return toOrder(
      await this.client.signedWrite('DELETE', '/v3/order', { symbol, orderId: ref.orderId, origClientOrderId: ref.clientOrderId }),
    );
  }
}
