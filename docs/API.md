# API (`/api/v1`)

All responses use one envelope. Success: `{ "success": true, "data": ..., "meta": { "timestamp", "requestId", "mode": "LIVE"|"DEMO" } }`. Error: `{ "success": false, "error": { "code", "message", "details"? } }` (never stack traces, credentials or driver text). Every response carries `X-Request-Id` (send your own to correlate logs). Contracts are zod schemas in `packages/shared/src/contracts.ts`, used by both sides.

Auth: `Authorization: Bearer <token>` from `/auth/pair`. Tokens are opaque, short-lived (`SESSION_TTL_MINUTES`, default 120) and stored server-side only as an HMAC.

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /health` | no | `{status, database, exchange, environment:"testnet"}` (minimal, no infrastructure detail) |
| `GET /diagnostics` | yes | DB/exchange latency and last exchange update, AI + STT provider status, server time. No secrets |
| `POST /auth/pair` | no (rate-limited 10/min) | `{pairingCode, deviceType}` -> `{accessToken, expiresAt, user}` |
| `POST /auth/refresh` | yes | Rotates the token (old one dies immediately) |
| `POST /auth/logout` | yes | Revokes the device session |
| `GET /auth/session` | yes | Current session info |
| `GET /portfolio` | yes | Valued balances (USDT), `totalValueUsdt` over **priced assets only**, `coverage {priced, unpriced, total, shown}`, `change24hPercent` + `change24hCoverage`, `biggestHolding`, source, timestamp, `ageMs`, `fresh` |
| `GET /portfolio/balances` / `/portfolio/summary` | yes | Balances only / everything except balances |
| `GET /market/ticker/:symbol` | yes | `{symbol, price, source, timestamp, ageMs, fresh}` (stale after 15 s) |
| `GET /market/stats/:symbol` | yes | 24h change/high/low/volume + freshness |
| `GET /market/exchange-info/:symbol` | yes | Symbol status and trading filters |
| `GET /watchlist` | yes | Items with live price/24h change (nulls if the exchange is down, never invented) |
| `POST /watchlist/assets` `{symbol}` / `DELETE /watchlist/assets/:symbol` | yes | Validated against exchange info; max 12; unique per list |
| `POST /agent/sessions` | yes | Starts a session, returns the greeting built from verified data + remembered context |
| `GET /agent/sessions`, `GET /agent/sessions/:id` | yes | History (own sessions only) |
| `POST /agent/sessions/:id/end` | yes | Ends the session, stores a deterministic summary |
| `POST /agent/message` | yes (60/min) | `{sessionId, text, source:"voice"|"text", displayedProposalId?}` -> `AgentReply` `{intent, response, sections[FACT|AI|UNVERIFIED|INFO], evidence[], requiresClarification, source, uiAction?}` |
| `POST /agent/transcribe` | yes | Raw 16 kHz 16-bit mono PCM (`application/octet-stream`, <= 20 s) -> `{text, provider}`; `501 STT_UNAVAILABLE` if no provider |
| `GET/POST /memory`, `PATCH/DELETE /memory/:id` | yes | Review, create, correct, delete own memories |
| `POST /trades/prepare` | yes | `{sessionId, symbol, side, orderType, quantity? | quoteOrderQty?, price?}` -> `TradeProposal` (`PENDING_APPROVAL`, `proposalHash`, `expiresAt`, warnings) |
| `GET /trades/proposals/:id` | yes | Proposal (lazily expires; reconciles `UNKNOWN`) |
| `POST /trades/proposals/:id/approve` | yes | `{sessionId, proposalHash, method}` |
| `POST /trades/proposals/:id/reject` | yes | `{sessionId?}` |
| `POST /trades/proposals/:id/execute` | yes | **No body.** Header `Idempotency-Key` required. Returns `{proposal, order, message}`; `Idempotent-Replay: true` on a replay |
| `GET /trades/orders`, `GET /trades/orders/:id` | yes | Orders; GET refreshes open/uncertain ones from Binance |
| `POST /trades/orders/:id/cancel` | yes | Explicit, id-addressed; verified with the exchange |
| `POST /demo/reset` | yes (not in production) | Closes pending proposals, resets watchlist, removes empty sessions; keeps exchange orders |

## Error codes worth knowing

`UNAUTHENTICATED`, `INVALID_PAIRING_CODE`, `VALIDATION_ERROR`, `INVALID_SYMBOL`, `UNKNOWN_SYMBOL`, `INSUFFICIENT_BALANCE`, `INVALID_PRECISION`, `BELOW_MIN_NOTIONAL`, `BELOW_MIN_QTY`, `PROPOSAL_NOT_FOUND` (also returned for another user's proposal), `PROPOSAL_EXPIRED`, `PROPOSAL_CHANGED` (hash mismatch), `SESSION_MISMATCH`, `APPROVAL_REQUIRED`, `APPROVAL_INVALID`, `INVALID_STATE`, `REQUOTE_REQUIRED` (409; `details.proposal` is the fresh quote needing fresh approval), `IDEMPOTENCY_KEY_REUSED`, `REQUEST_IN_PROGRESS`, `ALREADY_SUBMITTED`, `EXCHANGE_UNAVAILABLE`, `EXCHANGE_REJECTED`, `STT_UNAVAILABLE`, `RATE_LIMITED`.

## Intents

`START_SESSION, GET_PORTFOLIO, GET_BALANCE, GET_MARKET_PRICE, GET_MARKET_CHANGE, GET_WATCHLIST, ADD_WATCHLIST_ASSET, REMOVE_WATCHLIST_ASSET, ASK_FINANCIAL_QUESTION, PREPARE_TRADE, APPROVE_TRADE, REJECT_TRADE, GET_ORDER_STATUS, GET_HELP, UNKNOWN`, plus `SAVE_MEMORY` and `END_SESSION` (needed for the persistence journey). Cancelling an *exchange* order is HTTP-only (never inferred from speech).
