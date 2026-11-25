import type { AgentReply, ExecuteResult, MarketStats, Portfolio, TradeProposal, Watchlist } from '@pulse/shared';
import { initialState, type PulseState } from '../src/state/types';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

export const portfolio: Portfolio = {
  environment: 'TESTNET', totalValueUsdt: '123456.78', change24hPercent: '0.40', change24hCoverage: 'USDT + top 4 priced holdings',
  balances: [
    { asset: 'BTC', free: '1', locked: '0', total: '1', valueUsdt: '59980.00', valuationSource: 'BTCUSDT last price' },
    { asset: 'ETH', free: '10', locked: '0', total: '10', valueUsdt: '29900.00', valuationSource: 'ETHUSDT last price' },
    { asset: 'USDT', free: '10000', locked: '0', total: '10000', valueUsdt: '10000.00', valuationSource: 'USDT (quote asset)' },
    { asset: 'SOL', free: '4', locked: '0', total: '4', valueUsdt: '600.00', valuationSource: 'SOLUSDT last price' },
  ],
  coverage: { priced: 12, unpriced: 497, total: 509, shown: 4 }, biggestHolding: { asset: 'BTC', valueUsdt: '59980.00' },
  source: 'binance-spot-testnet', timestamp: iso(), ageMs: 3000, fresh: true,
};

export const watchlist: Watchlist = {
  timestamp: iso(),
  items: [
    { symbol: 'BTCUSDT', position: 0, price: '59980.00', change24hPercent: '2.40', fresh: true },
    { symbol: 'ETHUSDT', position: 1, price: '2990.00', change24hPercent: '-1.10', fresh: true },
    { symbol: 'BNBUSDT', position: 2, price: null, change24hPercent: null, fresh: false },
  ],
};

export const stats: MarketStats = {
  symbol: 'BTCUSDT', lastPrice: '59980.00', priceChangePercent: '2.40', highPrice: '61000.00', lowPrice: '58500.00',
  volume: '1000', quoteVolume: '60000000', source: 'binance-spot-testnet', timestamp: iso(), ageMs: 2000, fresh: true,
};

export const proposal = (over: Partial<TradeProposal> = {}): TradeProposal => ({
  id: uuid(1), userId: uuid(2), sessionId: uuid(3), environment: 'TESTNET', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET',
  quoteOrderQty: '20', referencePrice: '59980', estimatedQuantity: '0.00033', estimatedTotal: '20.00', estimatedFee: '0.0200',
  quoteAsset: 'USDT', baseAsset: 'BTC', warnings: [], status: 'PENDING_APPROVAL', proposalHash: 'a'.repeat(64),
  expiresAt: iso(120_000), createdAt: iso(), ...over,
});

export const reply = (over: Partial<AgentReply> = {}): AgentReply => ({
  intent: 'ASK_FINANCIAL_QUESTION', response: 'BTCUSDT is 59,980.00.', sections: [{ label: 'FACT', text: 'BTCUSDT is 59,980.00 (testnet).' }],
  evidence: [], requiresClarification: false, source: 'deterministic', ...over,
});

export const executeResult = (over: Partial<ExecuteResult> = {}): ExecuteResult => ({
  proposal: proposal({ status: 'FILLED' }),
  order: {
    id: uuid(9), proposalId: uuid(1), symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', status: 'FILLED', exchangeOrderId: '123456',
    clientOrderId: 'p' + 'a'.repeat(32), originalQuantity: '0.00033', executedQuantity: '0.00033', quoteQuantity: '19.79', averagePrice: '59980',
    confirmed: true, environment: 'TESTNET', updatedAt: iso(),
  },
  message: 'Bought 0.00033 BTC at avg 59980. Confirmed by Binance testnet.', ...over,
});

export const state = (over: Partial<PulseState> = {}): PulseState => ({ ...initialState, now: Date.now(), ...over });
