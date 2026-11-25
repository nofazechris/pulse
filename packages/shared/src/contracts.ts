import { z } from 'zod';

/** Every contract between the glasses app and the API. Money is always a decimal string. */

export const dataModeSchema = z.enum(['LIVE', 'DEMO']);
export type DataMode = z.infer<typeof dataModeSchema>;

export const environmentSchema = z.literal('TESTNET');

export const metaSchema = z.object({
  timestamp: z.string(),
  requestId: z.string().optional(),
  mode: dataModeSchema.optional(),
});

export function apiSuccess<T extends z.ZodType>(data: T) {
  return z.object({ success: z.literal(true), data, meta: metaSchema });
}
export const apiErrorSchema = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/);

// ---- health / diagnostics ----
export const healthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  database: z.enum(['connected', 'unavailable']),
  exchange: z.enum(['available', 'unavailable']),
  environment: z.literal('testnet'),
});
export type Health = z.infer<typeof healthSchema>;

export const diagnosticsSchema = z.object({
  database: z.object({ status: z.enum(['connected', 'unavailable']), latencyMs: z.number().nullable() }),
  exchange: z.object({
    status: z.enum(['available', 'unavailable']),
    environment: z.literal('testnet'),
    latencyMs: z.number().nullable(),
    lastUpdate: z.string().nullable(),
    mode: dataModeSchema,
  }),
  ai: z.object({ provider: z.string(), configured: z.boolean() }),
  stt: z.object({ provider: z.string(), configured: z.boolean() }),
  serverTime: z.string(),
});
export type Diagnostics = z.infer<typeof diagnosticsSchema>;

// ---- auth ----
export const pairRequestSchema = z.object({
  pairingCode: z.string().min(4).max(128),
  deviceType: z.enum(['g2-glasses', 'simulator', 'web']).default('simulator'),
  deviceIdentifier: z.string().max(128).optional(),
});
export const authSessionSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.string(),
  user: z.object({ id: z.string().uuid(), displayName: z.string().nullable() }),
});
export type AuthSession = z.infer<typeof authSessionSchema>;
export const sessionInfoSchema = z.object({
  expiresAt: z.string(),
  user: z.object({ id: z.string().uuid(), displayName: z.string().nullable() }),
});

// ---- market ----
export const freshnessFields = {
  source: z.string(),
  timestamp: z.string(),
  ageMs: z.number(),
  fresh: z.boolean(),
};
export const tickerSchema = z.object({ symbol: z.string(), price: decimalString, ...freshnessFields });
export type Ticker = z.infer<typeof tickerSchema>;
export const marketStatsSchema = z.object({
  symbol: z.string(),
  lastPrice: decimalString,
  priceChangePercent: decimalString,
  highPrice: decimalString,
  lowPrice: decimalString,
  volume: decimalString,
  quoteVolume: decimalString,
  ...freshnessFields,
});
export type MarketStats = z.infer<typeof marketStatsSchema>;

// ---- portfolio ----
export const balanceSchema = z.object({
  asset: z.string(),
  free: decimalString,
  locked: decimalString,
  total: decimalString,
  valueUsdt: decimalString.nullable(),
  valuationSource: z.string().nullable(),
});
export const portfolioSchema = z.object({
  environment: environmentSchema,
  /** Sum of USDT value over PRICED assets only. Unpriced assets are excluded and counted below. */
  totalValueUsdt: decimalString,
  change24hPercent: decimalString.nullable(),
  change24hCoverage: z.string(),
  balances: z.array(balanceSchema),
  coverage: z.object({ priced: z.number(), unpriced: z.number(), total: z.number(), shown: z.number() }),
  biggestHolding: z.object({ asset: z.string(), valueUsdt: decimalString }).nullable(),
  source: z.string(),
  timestamp: z.string(),
  ageMs: z.number(),
  fresh: z.boolean(),
});
export type Portfolio = z.infer<typeof portfolioSchema>;
export type Balance = z.infer<typeof balanceSchema>;

// ---- watchlist ----
export const watchlistItemSchema = z.object({
  symbol: z.string(),
  position: z.number(),
  price: decimalString.nullable(),
  change24hPercent: decimalString.nullable(),
  fresh: z.boolean(),
});
export const watchlistSchema = z.object({ items: z.array(watchlistItemSchema), timestamp: z.string() });
export type Watchlist = z.infer<typeof watchlistSchema>;
export const addWatchlistSchema = z.object({ symbol: z.string().min(2).max(20) });

// ---- trading ----
export const tradeStatusSchema = z.enum([
  'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUBMITTING', 'SUBMITTED',
  'PARTIALLY_FILLED', 'FILLED', 'FAILED', 'UNKNOWN',
]);
export type TradeStatus = z.infer<typeof tradeStatusSchema>;

export const prepareTradeSchema = z.object({
  sessionId: z.string().uuid(),
  symbol: z.string().min(5).max(20),
  side: z.enum(['BUY', 'SELL']),
  orderType: z.enum(['MARKET', 'LIMIT']),
  quantity: decimalString.optional(),
  quoteOrderQty: decimalString.optional(),
  price: decimalString.optional(),
});
export type PrepareTradeRequest = z.infer<typeof prepareTradeSchema>;

export const tradeProposalSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  sessionId: z.string().uuid(),
  environment: environmentSchema,
  symbol: z.string(),
  side: z.enum(['BUY', 'SELL']),
  orderType: z.enum(['MARKET', 'LIMIT']),
  quantity: decimalString.optional(),
  quoteOrderQty: decimalString.optional(),
  price: decimalString.optional(),
  referencePrice: decimalString,
  estimatedQuantity: decimalString.optional(),
  estimatedTotal: decimalString.optional(),
  estimatedFee: decimalString.optional(),
  quoteAsset: z.string(),
  baseAsset: z.string(),
  warnings: z.array(z.string()),
  status: tradeStatusSchema,
  /** Binds an approval to exactly these terms. The client echoes it back when approving. */
  proposalHash: z.string(),
  expiresAt: z.string(),
  createdAt: z.string(),
  failureReason: z.string().optional(),
});
export type TradeProposal = z.infer<typeof tradeProposalSchema>;

export const approveTradeSchema = z.object({
  sessionId: z.string().uuid(),
  proposalHash: z.string().min(16).max(128),
  method: z.enum(['glasses_gesture', 'voice']).default('glasses_gesture'),
});

export const exchangeOrderSchema = z.object({
  id: z.string().uuid(),
  proposalId: z.string().uuid(),
  symbol: z.string(),
  side: z.enum(['BUY', 'SELL']),
  orderType: z.enum(['MARKET', 'LIMIT']),
  status: z.string(),
  exchangeOrderId: z.string().nullable(),
  clientOrderId: z.string(),
  originalQuantity: decimalString.nullable(),
  executedQuantity: decimalString.nullable(),
  quoteQuantity: decimalString.nullable(),
  averagePrice: decimalString.nullable(),
  confirmed: z.boolean(),
  environment: environmentSchema,
  updatedAt: z.string(),
});
export type ExchangeOrderDto = z.infer<typeof exchangeOrderSchema>;

export const executeResultSchema = z.object({
  proposal: tradeProposalSchema,
  order: exchangeOrderSchema.nullable(),
  /** Human-safe status line derived ONLY from the exchange response. */
  message: z.string(),
});
export type ExecuteResult = z.infer<typeof executeResultSchema>;

// ---- memory ----
export const memoryCategorySchema = z.enum([
  'explicit_preference', 'financial_goal', 'interaction_preference', 'session_summary', 'temporary_context',
]);
export const memorySchema = z.object({
  id: z.string().uuid(),
  category: memoryCategorySchema,
  content: z.string(),
  source: z.string(),
  verification: z.enum(['user_confirmed', 'system_derived', 'unverified']),
  confidence: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string().nullable(),
});
export type Memory = z.infer<typeof memorySchema>;
export const createMemorySchema = z.object({
  category: memoryCategorySchema,
  content: z.string().min(1).max(500),
});
export const patchMemorySchema = z.object({
  content: z.string().min(1).max(500).optional(),
  category: memoryCategorySchema.optional(),
});

// ---- agent ----
export const intentSchema = z.enum([
  'START_SESSION', 'GET_PORTFOLIO', 'GET_BALANCE', 'GET_MARKET_PRICE', 'GET_MARKET_CHANGE',
  'GET_WATCHLIST', 'ADD_WATCHLIST_ASSET', 'REMOVE_WATCHLIST_ASSET', 'ASK_FINANCIAL_QUESTION',
  'PREPARE_TRADE', 'APPROVE_TRADE', 'REJECT_TRADE', 'GET_ORDER_STATUS', 'GET_HELP', 'UNKNOWN',
  // Additions beyond the PRD's minimum list, needed for Journey E (memory + ending a session).
  'SAVE_MEMORY', 'END_SESSION',
]);
export type Intent = z.infer<typeof intentSchema>;

export const agentSectionSchema = z.object({
  /** FACT = retrieved from the exchange; AI = model interpretation; UNVERIFIED = hypothesis. */
  label: z.enum(['FACT', 'AI', 'UNVERIFIED', 'INFO']),
  text: z.string(),
});
export const evidenceSchema = z.object({
  type: z.string(),
  reference: z.string(),
  value: z.string().optional(),
  timestamp: z.string().optional(),
});
export const agentReplySchema = z.object({
  intent: intentSchema,
  response: z.string(),
  sections: z.array(agentSectionSchema),
  evidence: z.array(evidenceSchema),
  requiresClarification: z.boolean(),
  source: z.enum(['deterministic', 'ai']),
  uiAction: z
    .discriminatedUnion('type', [
      z.object({ type: z.literal('SHOW_PROPOSAL'), proposal: tradeProposalSchema }),
      z.object({ type: z.literal('APPROVE_PROPOSAL'), proposalId: z.string().uuid(), proposalHash: z.string() }),
      z.object({ type: z.literal('REJECT_PROPOSAL'), proposalId: z.string().uuid() }),
      z.object({ type: z.literal('NAVIGATE'), screen: z.enum(['home', 'portfolio', 'market', 'watchlist', 'insight']) }),
      z.object({ type: z.literal('NONE') }),
    ])
    .optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type AgentReply = z.infer<typeof agentReplySchema>;

export const agentMessageRequestSchema = z.object({
  sessionId: z.string().uuid(),
  text: z.string().min(1).max(500),
  source: z.enum(['voice', 'text']).default('text'),
  /** Id of the proposal currently displayed on the glasses, if any (needed for voice approve/reject). */
  displayedProposalId: z.string().uuid().optional(),
});
export const agentSessionSchema = z.object({
  id: z.string().uuid(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  summary: z.string().nullable(),
  status: z.string(),
});
export const startSessionResultSchema = z.object({ session: agentSessionSchema, greeting: agentReplySchema });
export const transcriptionSchema = z.object({ text: z.string(), provider: z.string() });
