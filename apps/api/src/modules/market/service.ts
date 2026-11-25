import type { MarketStats, Ticker } from '@pulse/shared';
import { AppError } from '../../utils/errors';
import type { ExchangeAdapter, ExchangeInfo, SymbolInfo } from '../exchange/types';

/** PULSE freshness thresholds (application policy, not Binance guarantees). */
export const FRESHNESS = { tickerMs: 15_000, accountMs: 60_000 } as const;

export function freshness(fetchedAt: number, now: number, thresholdMs: number) {
  const ageMs = Math.max(0, now - fetchedAt);
  return { ageMs, fresh: ageMs <= thresholdMs };
}

const SYMBOL_RE = /^[A-Z0-9]{5,20}$/;
const INFO_TTL_MS = 10 * 60_000;
const PRICE_TTL_MS = 2_000;

interface Cached<T> { at: number; value: T }

export class MarketService {
  private info: Cached<Map<string, SymbolInfo>> | null = null;
  private infoInflight: Promise<Map<string, SymbolInfo>> | null = null;
  private tickers = new Map<string, Cached<Awaited<ReturnType<ExchangeAdapter['getTicker']>>>>();
  private prices: Cached<Awaited<ReturnType<ExchangeAdapter['getAllPrices']>>> | null = null;
  lastExchangeUpdate: number | null = null;

  constructor(readonly exchange: ExchangeAdapter, private readonly now: () => number = Date.now) {}

  /** Drops cached prices/symbols (tests, demo reset). */
  invalidate() {
    this.info = null;
    this.tickers.clear();
    this.prices = null;
  }

  private touch(t: number) {
    this.lastExchangeUpdate = Math.max(this.lastExchangeUpdate ?? 0, t);
  }

  async symbolMap(): Promise<Map<string, SymbolInfo>> {
    const t = this.now();
    if (this.info && t - this.info.at < INFO_TTL_MS) return this.info.value;
    this.infoInflight ??= this.exchange
      .getExchangeInfo()
      .then((i: ExchangeInfo) => {
        const m = new Map(i.symbols.map((s) => [s.symbol, s]));
        this.info = { at: this.now(), value: m };
        this.touch(i.fetchedAt);
        return m;
      })
      .finally(() => {
        this.infoInflight = null;
      });
    return this.infoInflight;
  }

  /** Validates format, existence and TRADING status. Throws AppError otherwise. */
  async requireSymbol(raw: string): Promise<SymbolInfo> {
    const symbol = raw.trim().toUpperCase();
    if (!SYMBOL_RE.test(symbol)) throw new AppError(400, 'INVALID_SYMBOL', 'That is not a valid trading symbol.');
    const info = (await this.symbolMap()).get(symbol);
    if (!info) throw new AppError(404, 'UNKNOWN_SYMBOL', `${symbol} is not listed on Binance Spot Testnet.`);
    if (info.status !== 'TRADING') throw new AppError(422, 'SYMBOL_NOT_TRADING', `${symbol} is not currently trading.`);
    return info;
  }

  /** `fresh: true` bypasses the short cache. Trade quotes and the pre-execution drift check always use it. */
  async getTicker(symbol: string, opts: { fresh?: boolean } = {}): Promise<Ticker> {
    await this.requireSymbol(symbol);
    const cached = opts.fresh ? undefined : this.tickers.get(symbol);
    const t = this.now();
    const data = cached && t - cached.at < PRICE_TTL_MS ? cached.value : await this.exchange.getTicker(symbol);
    if (data !== cached?.value) this.tickers.set(symbol, { at: this.now(), value: data });
    this.touch(data.fetchedAt);
    return {
      symbol, price: data.price, source: this.exchange.name, timestamp: new Date(data.fetchedAt).toISOString(),
      ...freshness(data.fetchedAt, this.now(), FRESHNESS.tickerMs),
    };
  }

  async getStats(symbol: string): Promise<MarketStats> {
    await this.requireSymbol(symbol);
    const s = await this.exchange.get24HourStats(symbol);
    this.touch(s.fetchedAt);
    return {
      symbol, lastPrice: s.lastPrice, priceChangePercent: s.priceChangePercent, highPrice: s.highPrice,
      lowPrice: s.lowPrice, volume: s.volume, quoteVolume: s.quoteVolume, source: this.exchange.name,
      timestamp: new Date(s.fetchedAt).toISOString(), ...freshness(s.fetchedAt, this.now(), FRESHNESS.tickerMs),
    };
  }

  async getStatsMany(symbols: string[]): Promise<Map<string, MarketStats>> {
    const raw = await this.exchange.get24HourStatsMany(symbols);
    const out = new Map<string, MarketStats>();
    for (const s of raw) {
      this.touch(s.fetchedAt);
      out.set(s.symbol, {
        symbol: s.symbol, lastPrice: s.lastPrice, priceChangePercent: s.priceChangePercent, highPrice: s.highPrice,
        lowPrice: s.lowPrice, volume: s.volume, quoteVolume: s.quoteVolume, source: this.exchange.name,
        timestamp: new Date(s.fetchedAt).toISOString(), ...freshness(s.fetchedAt, this.now(), FRESHNESS.tickerMs),
      });
    }
    return out;
  }

  async getAllPrices() {
    const t = this.now();
    if (this.prices && t - this.prices.at < PRICE_TTL_MS * 2) return this.prices.value;
    const value = await this.exchange.getAllPrices();
    this.prices = { at: this.now(), value };
    this.touch(value.fetchedAt);
    return value;
  }
}
