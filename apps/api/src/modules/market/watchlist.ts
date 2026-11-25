import { and, eq, max } from 'drizzle-orm';
import type { Watchlist } from '@pulse/shared';
import type { Db } from '../../db/client';
import { watchlistAssets, watchlists } from '../../db/schema';
import { AppError } from '../../utils/errors';
import type { MarketService } from './service';

const DEFAULT_SEED = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
const MAX_ASSETS = 12;

export class WatchlistService {
  constructor(private readonly db: Db, private readonly market: MarketService) {}

  private async ensureDefault(userId: string): Promise<string> {
    const find = () =>
      this.db.select({ id: watchlists.id }).from(watchlists).where(and(eq(watchlists.userId, userId), eq(watchlists.isDefault, true))).limit(1);
    const existing = (await find())[0];
    if (existing) return existing.id;
    const created = await this.db
      .insert(watchlists).values({ userId, name: 'Default', isDefault: true })
      .onConflictDoNothing().returning({ id: watchlists.id });
    if (created[0]) {
      await this.db.insert(watchlistAssets).values(DEFAULT_SEED.map((symbol, position) => ({ watchlistId: created[0]!.id, symbol, position })))
        .onConflictDoNothing();
      return created[0].id;
    }
    return (await find())[0]!.id;
  }

  async symbols(userId: string): Promise<string[]> {
    const id = await this.ensureDefault(userId);
    const rows = await this.db.select().from(watchlistAssets).where(eq(watchlistAssets.watchlistId, id)).orderBy(watchlistAssets.position);
    return rows.map((r) => r.symbol);
  }

  async list(userId: string): Promise<Watchlist> {
    const syms = await this.symbols(userId);
    let stats = new Map<string, { lastPrice: string; priceChangePercent: string; fresh: boolean }>();
    try {
      stats = await this.market.getStatsMany(syms);
    } catch {
      // Exchange down: return the list without values; never invent prices.
    }
    return {
      timestamp: new Date().toISOString(),
      items: syms.map((symbol, position) => {
        const s = stats.get(symbol);
        return { symbol, position, price: s?.lastPrice ?? null, change24hPercent: s?.priceChangePercent ?? null, fresh: s?.fresh ?? false };
      }),
    };
  }

  async add(userId: string, rawSymbol: string): Promise<string[]> {
    const info = await this.market.requireSymbol(rawSymbol);
    const id = await this.ensureDefault(userId);
    const current = await this.symbols(userId);
    if (current.includes(info.symbol)) return current;
    if (current.length >= MAX_ASSETS) throw new AppError(422, 'WATCHLIST_FULL', `Your watchlist is full (${MAX_ASSETS} assets).`);
    const [m] = await this.db.select({ m: max(watchlistAssets.position) }).from(watchlistAssets).where(eq(watchlistAssets.watchlistId, id));
    await this.db.insert(watchlistAssets).values({ watchlistId: id, symbol: info.symbol, position: (m?.m ?? -1) + 1 }).onConflictDoNothing();
    return this.symbols(userId);
  }

  async remove(userId: string, rawSymbol: string): Promise<string[]> {
    const symbol = rawSymbol.trim().toUpperCase();
    const id = await this.ensureDefault(userId);
    const removed = await this.db.delete(watchlistAssets).where(and(eq(watchlistAssets.watchlistId, id), eq(watchlistAssets.symbol, symbol))).returning({ id: watchlistAssets.id });
    if (removed.length === 0) throw new AppError(404, 'NOT_IN_WATCHLIST', `${symbol} is not in your watchlist.`);
    return this.symbols(userId);
  }
}
