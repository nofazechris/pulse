import type { Env } from './config/env';
import { createDb, pingDatabase, type Db, type DbPingResult } from './db/client';
import { AuditService } from './security/audit';
import { createAIProvider } from './modules/ai/providers';
import { createSttProvider, type SpeechRecognitionProvider } from './modules/ai/stt';
import type { AIProvider } from './modules/ai/types';
import { AgentService } from './modules/agent/service';
import { BinanceSpotTestnetAdapter } from './modules/exchange/binance-adapter';
import { FakeExchangeAdapter } from './modules/exchange/fake-adapter';
import type { ExchangeAdapter } from './modules/exchange/types';
import { MarketService } from './modules/market/service';
import { WatchlistService } from './modules/market/watchlist';
import { MemoryService } from './modules/memory/service';
import { PortfolioService } from './modules/portfolio/service';
import { AgentSessionService } from './modules/sessions/agent-sessions';
import { AuthService } from './modules/sessions/auth';
import { TradingService } from './modules/trading/service';
import { PlanService } from './modules/trading/plans';

export interface Services {
  mode: 'LIVE' | 'DEMO';
  db: Db;
  dbPing: () => Promise<DbPingResult>;
  exchange: ExchangeAdapter;
  ai: AIProvider;
  stt: SpeechRecognitionProvider;
  audit: AuditService;
  auth: AuthService;
  market: MarketService;
  portfolio: PortfolioService;
  watchlist: WatchlistService;
  sessions: AgentSessionService;
  memory: MemoryService;
  trading: TradingService;
  plans: PlanService;
  agent: AgentService;
}

export interface ServiceOverrides {
  db?: Db;
  dbPing?: () => Promise<DbPingResult>;
  exchange?: ExchangeAdapter;
  ai?: AIProvider;
  stt?: SpeechRecognitionProvider;
}

type Logger = { warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void; debug: (o: object, m?: string) => void };

/**
 * Composition root. The exchange is the real Binance Spot TESTNET adapter unless DEMO_MODE=true is set
 * explicitly; it never falls back to fake data on its own.
 */
export function createServices(env: Env, overrides: ServiceOverrides = {}, log?: Logger): Services {
  const db = overrides.db ?? (env.DATABASE_URL ? createDb(env.DATABASE_URL).db : undefined);
  if (!db) throw new Error('DATABASE_URL is required (Neon PostgreSQL is the only application database).');
  const dbPing = overrides.dbPing ?? (() => {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL missing');
    return pingDatabase(env.DATABASE_URL);
  });

  const mode: 'LIVE' | 'DEMO' = env.DEMO_MODE ? 'DEMO' : 'LIVE';
  const exchange: ExchangeAdapter =
    overrides.exchange ??
    (env.DEMO_MODE
      ? new FakeExchangeAdapter()
      : new BinanceSpotTestnetAdapter({ restUrl: env.BINANCE_TESTNET_REST_URL, apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET, ...(log ? { log } : {}) }));

  const ai = overrides.ai ?? createAIProvider(env);
  const stt = overrides.stt ?? createSttProvider(env);
  const audit = new AuditService(db, (err) => log?.error({ err: err instanceof Error ? err.message : 'unknown' }, 'audit write failed'));
  const auth = new AuthService(db, env, audit);
  const market = new MarketService(exchange);
  const portfolio = new PortfolioService(market);
  const watchlist = new WatchlistService(db, market);
  const sessions = new AgentSessionService(db);
  const memory = new MemoryService(db);
  const trading = new TradingService(db, market, portfolio, exchange, audit, sessions, env);
  const plans = new PlanService(db, market, trading, sessions, audit);
  const agent = new AgentService({ plans, market, portfolio, watchlist, trading, sessions, memory, ai, audit, mode, ...(log ? { log } : {}) });
  return { mode, db, dbPing, exchange, ai, stt, audit, auth, market, portfolio, watchlist, sessions, memory, trading, plans, agent };
}
