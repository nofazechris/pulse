import { sql } from 'drizzle-orm';
import {
  boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

/**
 * Neon PostgreSQL schema. UUID primary keys, FKs, numeric for money (returned as strings by the
 * driver, never floats). Child rows of a user cascade on delete; audit_logs keeps history (SET NULL).
 */
const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const userFk = () => uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' });

export const users = pgTable('users', {
  id: id(),
  email: text('email').unique(),
  displayName: text('display_name'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  status: text('status').notNull().default('active'),
});

export const deviceSessions = pgTable(
  'device_sessions',
  {
    id: id(),
    userId: userFk(),
    deviceType: text('device_type').notNull(),
    deviceIdentifier: text('device_identifier'),
    sessionTokenHash: text('session_token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('device_sessions_token_hash_idx').on(t.sessionTokenHash), index('device_sessions_user_idx').on(t.userId)],
);

/** Table exists per the PRD. The MVP uses a single server-side testnet credential from env, so it is unused. */
export const exchangeConnections = pgTable('exchange_connections', {
  id: id(),
  userId: userFk(),
  exchange: text('exchange').notNull(),
  environment: text('environment').notNull(),
  apiKeyReference: text('api_key_reference').notNull(),
  encryptedSecret: text('encrypted_secret').notNull(),
  permissions: jsonb('permissions').notNull().default({}),
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const userPreferences = pgTable(
  'user_preferences',
  {
    id: id(),
    userId: userFk(),
    preferenceKey: text('preference_key').notNull(),
    preferenceValue: jsonb('preference_value').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('user_preferences_user_key_idx').on(t.userId, t.preferenceKey)],
);

export const userMemories = pgTable(
  'user_memories',
  {
    id: id(),
    userId: userFk(),
    category: text('category').notNull(),
    content: text('content').notNull(),
    source: text('source').notNull(),
    verification: text('verification').notNull(),
    confidence: numeric('confidence'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [index('user_memories_user_cat_idx').on(t.userId, t.category)],
);

export const watchlists = pgTable(
  'watchlists',
  {
    id: id(),
    userId: userFk(),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('watchlists_user_name_idx').on(t.userId, t.name)],
);

export const watchlistAssets = pgTable(
  'watchlist_assets',
  {
    id: id(),
    watchlistId: uuid('watchlist_id').notNull().references(() => watchlists.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    position: integer('position').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('watchlist_assets_unique_idx').on(t.watchlistId, t.symbol)],
);

export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: id(),
    userId: userFk(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    summary: text('summary'),
    status: text('status').notNull().default('active'),
  },
  (t) => [index('agent_sessions_user_idx').on(t.userId, t.startedAt)],
);

export const agentMessages = pgTable(
  'agent_messages',
  {
    id: id(),
    sessionId: uuid('session_id').notNull().references(() => agentSessions.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    intent: text('intent'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('agent_messages_session_idx').on(t.sessionId, t.createdAt)],
);

export const tradeProposals = pgTable(
  'trade_proposals',
  {
    id: id(),
    userId: userFk(),
    sessionId: uuid('session_id').notNull().references(() => agentSessions.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    side: text('side').notNull(),
    orderType: text('order_type').notNull(),
    quantity: numeric('quantity'),
    quoteOrderQty: numeric('quote_order_qty'),
    price: numeric('price'),
    environment: text('environment').notNull(),
    status: text('status').notNull(),
    /** Full display snapshot (reference price, estimates, warnings). */
    proposalSnapshot: jsonb('proposal_snapshot').notNull(),
    /** SHA-256 over the canonical material terms. Approval is bound to this value. */
    proposalHash: text('proposal_hash').notNull(),
    failureReason: text('failure_reason'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('trade_proposals_user_idx').on(t.userId, t.createdAt), index('trade_proposals_session_idx').on(t.sessionId)],
);

export const tradeApprovals = pgTable(
  'trade_approvals',
  {
    id: id(),
    proposalId: uuid('proposal_id').notNull().references(() => tradeProposals.id, { onDelete: 'cascade' }),
    userId: userFk(),
    sessionId: uuid('session_id').notNull().references(() => agentSessions.id, { onDelete: 'cascade' }),
    approvedSnapshot: jsonb('approved_snapshot').notNull(),
    approvalMethod: text('approval_method').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // At most one approval per proposal.
  (t) => [uniqueIndex('trade_approvals_proposal_idx').on(t.proposalId)],
);

export const exchangeOrders = pgTable(
  'exchange_orders',
  {
    id: id(),
    userId: userFk(),
    proposalId: uuid('proposal_id').notNull().references(() => tradeProposals.id, { onDelete: 'cascade' }),
    exchange: text('exchange').notNull(),
    environment: text('environment').notNull(),
    symbol: text('symbol').notNull(),
    exchangeOrderId: text('exchange_order_id'),
    clientOrderId: text('client_order_id').notNull(),
    side: text('side').notNull(),
    orderType: text('order_type').notNull(),
    status: text('status').notNull(),
    originalQuantity: numeric('original_quantity'),
    executedQuantity: numeric('executed_quantity'),
    quoteQuantity: numeric('quote_quantity'),
    averagePrice: numeric('average_price'),
    exchangeResponse: jsonb('exchange_response').notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // DB-level duplicate-order guard: one order per proposal, one client order id globally.
    uniqueIndex('exchange_orders_proposal_idx').on(t.proposalId),
    uniqueIndex('exchange_orders_client_id_idx').on(t.clientOrderId),
    index('exchange_orders_user_idx').on(t.userId, t.createdAt),
  ],
);

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: id(),
    userId: userFk(),
    idempotencyKey: text('idempotency_key').notNull(),
    operation: text('operation').notNull(),
    requestHash: text('request_hash').notNull(),
    responseSnapshot: jsonb('response_snapshot'),
    status: text('status').notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('idempotency_user_key_op_idx').on(t.userId, t.idempotencyKey, t.operation)],
);

/** Trade plans: a price condition that, once met, ALERTS and prepares a proposal. It never trades by itself. */
export const tradePlans = pgTable(
  'trade_plans',
  {
    id: id(),
    userId: userFk(),
    symbol: text('symbol').notNull(),
    direction: text('direction').notNull(),
    triggerPrice: numeric('trigger_price').notNull(),
    referencePrice: numeric('reference_price').notNull(),
    side: text('side'),
    quoteOrderQty: numeric('quote_order_qty'),
    quantity: numeric('quantity'),
    status: text('status').notNull().default('ARMED'),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    triggeredAt: timestamp('triggered_at', { withTimezone: true }),
    observedPrice: numeric('observed_price'),
    /** Share of the free balance to sell (0-1], sized when the plan fires. */
    sellFraction: numeric('sell_fraction'),
    /** Set by the server watcher when the level was reached; the wearer has not been told yet while status is ARMED. */
    hitAt: timestamp('hit_at', { withTimezone: true }),
    hitPrice: numeric('hit_price'),
  },
  (t) => [index('trade_plans_user_status_idx').on(t.userId, t.status)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    sessionId: uuid('session_id'),
    eventType: text('event_type').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('audit_logs_user_idx').on(t.userId, t.createdAt), index('audit_logs_event_idx').on(t.eventType)],
);
