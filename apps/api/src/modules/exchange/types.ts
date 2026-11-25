/** Internal exchange types. Monetary values are decimal strings. */

export interface SymbolFilters {
  tickSize?: string;
  minPrice?: string;
  maxPrice?: string;
  stepSize?: string;
  minQty?: string;
  maxQty?: string;
  marketStepSize?: string;
  marketMinQty?: string;
  marketMaxQty?: string;
  minNotional?: string;
  applyMinToMarket: boolean;
  maxNotional?: string;
}

export interface SymbolInfo {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  orderTypes: string[];
  filters: SymbolFilters;
}

export interface ExchangeInfo {
  symbols: SymbolInfo[];
  fetchedAt: number;
}

export interface ServerTime {
  serverTime: number;
}

export interface TickerData {
  symbol: string;
  price: string;
  fetchedAt: number;
}

export interface RawMarketStats {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
  fetchedAt: number;
}

export interface ExchangeBalance {
  asset: string;
  free: string;
  locked: string;
}

export interface ExchangeAccount {
  canTrade: boolean;
  balances: ExchangeBalance[];
  /** Taker fee as a fraction string, e.g. "0.001". */
  takerFee: string;
  updateTime: number;
  fetchedAt: number;
}

export type OrderSide = 'BUY' | 'SELL';
export type OrderKind = 'MARKET' | 'LIMIT';

export interface ExchangeOrder {
  orderId: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: string;
  status: string;
  price: string;
  origQty: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  /** cummulativeQuoteQty / executedQty when executedQty > 0, else null. */
  averagePrice: string | null;
  time: number;
  fetchedAt: number;
}

declare const validatedBrand: unique symbol;
export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  type: OrderKind;
  quantity?: string;
  quoteOrderQty?: string;
  price?: string;
  timeInForce?: 'GTC';
  newClientOrderId: string;
}
/** Only the trading module can mint this; the adapter refuses anything else at the type level. */
export type ValidatedOrderRequest = OrderRequest & { readonly [validatedBrand]: true };
export function markValidated(req: OrderRequest): ValidatedOrderRequest {
  return req as ValidatedOrderRequest;
}

export interface OrderRef {
  orderId?: string;
  clientOrderId?: string;
}

export interface ExchangeAdapter {
  readonly name: string;
  getServerTime(): Promise<ServerTime>;
  getExchangeInfo(symbol?: string): Promise<ExchangeInfo>;
  getTicker(symbol: string): Promise<TickerData>;
  getAllPrices(): Promise<{ prices: Map<string, string>; fetchedAt: number }>;
  get24HourStats(symbol: string): Promise<RawMarketStats>;
  get24HourStatsMany(symbols: string[]): Promise<RawMarketStats[]>;
  getAccount(): Promise<ExchangeAccount>;
  getOpenOrders(symbol?: string): Promise<ExchangeOrder[]>;
  getOrder(symbol: string, ref: OrderRef): Promise<ExchangeOrder>;
  createOrder(request: ValidatedOrderRequest): Promise<ExchangeOrder>;
  cancelOrder(symbol: string, ref: OrderRef): Promise<ExchangeOrder>;
}

/** Network failure, timeout, 429/418 or 5xx. The outcome of a WRITE is uncertain when this is thrown. */
export class ExchangeUnavailableError extends Error {
  constructor(message: string, readonly uncertainWrite = true) {
    super(message);
    this.name = 'ExchangeUnavailableError';
  }
}

/** Binance answered with a definitive 4xx error body. For a write this means "not accepted". */
export class ExchangeRejectedError extends Error {
  constructor(readonly status: number, readonly code: number | undefined, readonly exchangeMessage: string) {
    super(`Binance rejected the request (${code ?? status}): ${exchangeMessage}`);
    this.name = 'ExchangeRejectedError';
  }
}

export class ExchangeNotConfiguredError extends Error {
  constructor() {
    super('Binance Testnet API credentials are not configured.');
    this.name = 'ExchangeNotConfiguredError';
  }
}

/** Binance -2013: the order does not exist (so a prior submission was NOT accepted). */
export const BINANCE_ORDER_NOT_FOUND = -2013;
