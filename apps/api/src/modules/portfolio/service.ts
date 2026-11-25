import { dec, type Balance, type Portfolio } from '@pulse/shared';
import { ExchangeUnavailableError, type ExchangeAccount } from '../exchange/types';
import { FRESHNESS, freshness, type MarketService } from '../market/service';

const MAX_SHOWN = 15;
const CHANGE_TOP_N = 10;
const ACCOUNT_TTL_MS = 5_000;

export interface ValuedBalance extends Balance {
  valueDec: bigint | null;
}

/** Pure valuation. Only assets with a direct <ASSET>USDT market are priced; the rest are excluded and counted. */
export function valueBalances(
  account: Pick<ExchangeAccount, 'balances'>,
  prices: Map<string, string>,
  tradable: ReadonlySet<string>,
): ValuedBalance[] {
  return account.balances.map((b) => {
    const total = dec.add(dec.parse(b.free), dec.parse(b.locked));
    let price: bigint | null = null;
    let source: string | null = null;
    if (b.asset === 'USDT') {
      price = dec.parse('1');
      source = 'USDT (quote asset)';
    } else if (tradable.has(`${b.asset}USDT`) && prices.has(`${b.asset}USDT`)) {
      price = dec.parse(prices.get(`${b.asset}USDT`)!);
      source = `${b.asset}USDT last price`;
    }
    const valueDec = price === null ? null : dec.mul(total, price);
    return {
      asset: b.asset, free: b.free, locked: b.locked, total: dec.fmt(total),
      valueUsdt: valueDec === null ? null : dec.fmtFixed(valueDec, 2), valuationSource: source, valueDec,
    };
  });
}

export class PortfolioService {
  private account: { at: number; value: ExchangeAccount } | null = null;

  constructor(private readonly market: MarketService, private readonly now: () => number = Date.now) {}

  invalidate() {
    this.account = null;
  }

  async getAccount(force = false): Promise<ExchangeAccount> {
    if (!force && this.account && this.now() - this.account.at < ACCOUNT_TTL_MS) return this.account.value;
    const value = await this.market.exchange.getAccount();
    this.account = { at: this.now(), value };
    this.market.lastExchangeUpdate = Math.max(this.market.lastExchangeUpdate ?? 0, value.fetchedAt);
    return value;
  }

  async getBalance(asset: string) {
    const acc = await this.getAccount();
    const b = acc.balances.find((x) => x.asset === asset.toUpperCase());
    const free = b?.free ?? '0';
    const locked = b?.locked ?? '0';
    return {
      asset: asset.toUpperCase(), free, locked, total: dec.fmt(dec.add(dec.parse(free), dec.parse(locked))),
      timestamp: new Date(acc.fetchedAt).toISOString(), ...freshness(acc.fetchedAt, this.now(), FRESHNESS.accountMs),
    };
  }

  async getPortfolio(): Promise<Portfolio> {
    const [account, priceData, symbols] = await Promise.all([
      this.getAccount(), this.market.getAllPrices(), this.market.symbolMap(),
    ]);
    const tradable = new Set([...symbols.values()].filter((s) => s.status === 'TRADING').map((s) => s.symbol));
    const valued = valueBalances(account, priceData.prices, tradable);
    const priced = valued.filter((v) => v.valueDec !== null).sort((a, b) => (a.valueDec! > b.valueDec! ? -1 : 1));
    const total = priced.reduce((s, v) => dec.add(s, v.valueDec!), dec.ZERO);

    // 24h change over the largest priced holdings (stablecoin-pegged USDT counts as 0%).
    let change: string | null = null;
    let coverage = 'unavailable';
    try {
      const top = priced.filter((v) => v.asset !== 'USDT').slice(0, CHANGE_TOP_N);
      const stats = await this.market.getStatsMany(top.map((v) => `${v.asset}USDT`));
      let now = dec.ZERO;
      let prev = dec.ZERO;
      const usdt = priced.find((v) => v.asset === 'USDT');
      if (usdt) { now = dec.add(now, usdt.valueDec!); prev = dec.add(prev, usdt.valueDec!); }
      for (const v of top) {
        const s = stats.get(`${v.asset}USDT`);
        if (!s) continue;
        const factor = dec.add(dec.parse('1'), dec.div(dec.parse(s.priceChangePercent), dec.parse('100')));
        now = dec.add(now, v.valueDec!);
        prev = dec.add(prev, dec.div(v.valueDec!, factor));
      }
      if (dec.gt(prev, dec.ZERO)) {
        change = dec.fmtFixed(dec.pctChange(prev, now), 2);
        coverage = `USDT + top ${top.length} priced holdings`;
      }
    } catch (err) {
      if (!(err instanceof ExchangeUnavailableError)) throw err;
    }

    const shown = priced.slice(0, MAX_SHOWN).map(({ valueDec: _v, ...rest }) => rest);
    const fetchedAt = Math.min(account.fetchedAt, priceData.fetchedAt);
    return {
      environment: 'TESTNET',
      totalValueUsdt: dec.fmtFixed(total, 2),
      change24hPercent: change,
      change24hCoverage: coverage,
      balances: shown,
      coverage: { priced: priced.length, unpriced: valued.length - priced.length, total: valued.length, shown: shown.length },
      biggestHolding: priced[0] ? { asset: priced[0].asset, valueUsdt: dec.fmtFixed(priced[0].valueDec!, 2) } : null,
      source: this.market.exchange.name,
      timestamp: new Date(fetchedAt).toISOString(),
      ...freshness(fetchedAt, this.now(), FRESHNESS.accountMs),
    };
  }
}
