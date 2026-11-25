# Testing

Everything runs with Vitest from the repo root. Set `TEST_LOG_LEVEL=error` to see server errors during DB tests and `PULSE_DB_DEBUG=1` to log Neon transport retries.

| Command | What runs | Needs |
|---|---|---|
| `npm test` | all `*.test.ts` except `*.live.test.ts` | Neon (`DATABASE_URL`); DB-backed files skip themselves if it is absent. Uses a fake exchange, never touches Binance |
| `npm run test:integration` | `*.live.test.ts`: live Binance Spot **Testnet** + Neon | Testnet key + Neon. Places **small real testnet orders** through the approval flow (fake money) |
| `npm run typecheck` | strict `tsc` on every workspace | - |

## Last results (2026-11-25)

- `npm test`: **178 passed, 0 failed** (73 unit + 26 trade-safety + 23 journeys in the API, 56 in the glasses app), ~150 s because every Neon call costs ~250 ms from the test machine.
- `npm run test:integration`: **12 live testnet/Neon tests passed** (two runs: the first had 1 wrong expectation of mine, fixed; the market BUY test then passed alone). These placed small real testnet orders.
- `npm run typecheck`: clean on all workspaces.
- Earlier runs of the DB-backed suites showed intermittent failures caused by Neon HTTP connect timeouts from this network; fixed with a keep-alive pool and short connect timeout (see PROJECT.md).

## Suites

| File | Covers |
|---|---|
| `apps/api/tests/unit.test.ts` | exact decimals; order validation + normalisation; approval state machine; proposal hash; **testnet-only enforcement** (12 hostile URLs, env, allow-list, client blocks unlisted endpoints before any network call); Binance client signing/retry/timeouts (mocked network); intent parsing (information vs action, "approve" strictness, trade parameters, explicit-only memory); AI output validation (grounding, invented numbers, model cannot approve); freshness; portfolio valuation (junk assets excluded); memory retrieval; audit redaction; error normalisation; WAV wrapper; env validation |
| `apps/api/tests/trade-safety.test.ts` | PRD 17.3 against Neon with a fake exchange through the real HTTP routes: no execution without approval; execute ignores body parameters; expired proposals; other users' proposals; wrong session; changed parameters / tampered hash / tampered approval snapshot; supersede; duplicate and concurrent execution (one order); idempotency key reuse; timeout reconciliation (never accepted / accepted / unverifiable -> UNKNOWN, no resubmission); definitive rejection; price drift re-quote; invalid symbols; insufficient balance (prepare and at execution); precision/min-notional; lot rounding warning; **LLM cannot bypass the backend** (prompt-injection text, evil provider returning APPROVE_TRADE and an oversized trade); model text cannot mark an order successful; non-testnet environment; explicit cancel; audit trail without secrets |
| `apps/api/tests/journeys.test.ts` | PRD journeys A-E (session, portfolio, grounded market answers, prepare -> approve -> execute -> status, persistent memory across sessions), auth (pairing, rotation, logout, expiry, token only stored hashed), watchlist, memory review/correct/delete and ownership, speech endpoint, demo reset keeps exchange history |
| `apps/api/tests/binance.live.test.ts` | live testnet: public data, signed account, signature really verified, portfolio valuation, market answers, a market BUY approved and executed then verified independently on Binance, a resting LIMIT BUY then cancelled by id, min-notional rejection |
| `apps/glasses/tests/screens.test.ts` | every screen state renders ASCII only, <= 6 body lines, short header/footer, far below the container limits; content rules (labels, TESTNET/DEMO, REJECT default, no "success" without confirmation, stale flag) |
| `apps/glasses/tests/controller.test.ts` | connection/offline/pairing/401 states; gesture navigation and dedupe; voice state machine (no audio, audio -> STT -> message, cancel, no duplicate requests while processing, STT unavailable); **approval safety on the glasses** (default REJECT, tap = reject, double-tap/long-press = cancel, swipe + tap approves the displayed hash then executes, no double submit, voice approval only for the proposal on screen, re-quote, expiry); stale-response handling |

## Simulator verification

Automated tests use `SimulatorAdapter` (in-memory). The official simulator is exercised by hand/automation (`npm run simulator:auto`, control API on `:9898`: screenshots, input). Results are recorded in [PROJECT.md](PROJECT.md) with screenshots in `docs/smoke/`.

## Not covered (be honest)

Real G2 hardware; real microphone audio through the simulator/device; real LLM and STT providers (no keys supplied); a WebSocket market stream (REST polling only); the Even app whitelist/CORS on a device.
