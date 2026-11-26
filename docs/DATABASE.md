# Database (Neon PostgreSQL only)

Drizzle ORM + Drizzle Kit; schema in `apps/api/src/db/schema.ts`, migrations in `apps/api/drizzle/`. Runtime uses the **pooled** URL (`DATABASE_URL`); migrations prefer `DATABASE_DIRECT_URL`. Applied to the project with `npm run db:migrate` (migrations `0000_init`, `0001_trade_plans` and `0002_plan_watching`, 15 tables). `npm run db:studio` opens Drizzle Studio.

Conventions: UUID primary keys (`gen_random_uuid()`), `timestamptz`, money/quantities as `numeric` (the driver returns strings; all arithmetic is exact BigInt decimals in `packages/shared/src/decimal.ts`, never floats). Child rows of a user cascade on delete; `audit_logs.user_id` is `SET NULL` so history survives.

| Table | Notes |
|---|---|
| `users` | `email` unique, `status` |
| `device_sessions` | `session_token_hash` = HMAC-SHA256(token) (unique), `expires_at`, `revoked_at` |
| `exchange_connections` | Exists per the PRD but **unused**: the MVP uses one server-side testnet credential from env (no multi-user secret storage built) |
| `user_preferences` | unique `(user_id, preference_key)`, JSONB value (e.g. `preferred_quote`) |
| `user_memories` | `category`, `source`, `verification`, optional `expires_at`; only explicit user statements are written |
| `watchlists` / `watchlist_assets` | unique `(user_id, name)`; unique `(watchlist_id, symbol)` |
| `agent_sessions` / `agent_messages` | conversation + deterministic summary; no raw audio is stored |
| `trade_proposals` | extra columns beyond the PRD: `proposal_hash`, `failure_reason`; `proposal_snapshot` JSONB holds the displayed estimates/warnings |
| `trade_approvals` | unique `proposal_id` (one approval per proposal), `approved_snapshot` JSONB with the exact approved terms + hash |
| `trade_plans` | price condition + optional offered action; `ARMED -> TRIGGERED | CANCELLED | EXPIRED`; fired by compare-and-set so it can only fire once (migrations `0001_trade_plans`, `0002_plan_watching`: `sell_fraction`, `hit_at`, `hit_price`) |
| `exchange_orders` | unique `proposal_id` and unique `client_order_id` (database-level duplicate-order guard); `exchange_response` JSONB |
| `idempotency_records` | unique `(user_id, idempotency_key, operation)`, stored response for replays |
| `audit_logs` | event type, resource, sanitised metadata (credential-looking keys are redacted at any depth) |

Seed data: none except a default watchlist (BTCUSDT, ETHUSDT, BNBUSDT) created on first use. The demo pairing flow provisions one user `demo@pulse.local`.

Test data: the DB-backed tests create throw-away users (`test-<uuid>@pulse.test`) and delete them (cascade) afterwards.
