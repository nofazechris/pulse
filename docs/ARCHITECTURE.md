# Architecture

> **AI interprets. Verified services retrieve data. The backend validates. The user authorizes. Binance executes.**

```text
   Even G2 (display, touch, mic)  <--BLE-->  Even app WebView  --HTTPS-->  PULSE API (Fastify)
                                                  |                           |
                                      apps/glasses (Vite+React+TS)     +------+-----------+----------------+
                                      EvenHubAdapter / SimulatorAdapter|      |          |                |
                                                                   Agent   Trading     Market/Portfolio  Memory
                                                                   (intents,  (proposals, (Binance Spot    (Neon)
                                                                    AI, STT)   approval,   Testnet only)
                                                                              execute)
                                                                       |          |           |
                                                                   LLM/STT      Neon       Binance Testnet
                                                                  (optional)  Postgres      (signed REST)
```

## Repository

| Path | Responsibility |
|---|---|
| `apps/glasses` | Even Hub app. `sdk/` adapters, `services/api.ts` typed client, `state/controller.ts` gestures + voice state machine + approval flow, `screens/` pure view renderers, `App.tsx` companion panel |
| `apps/api` | Fastify API. `modules/exchange` (guard, signed client, adapter, fake), `market`, `portfolio`, `trading` (state machine, validation, hash, service), `ai` (intent parser, providers, grounding validation, STT), `agent` (orchestrator), `memory`, `sessions` (auth, agent sessions), `db` (Drizzle schema, Neon client), `security/audit` |
| `packages/shared` | zod contracts for every request/response, exact decimal maths, display facts, number formatting |
| `apps/api/drizzle` | SQL migrations |

## Boundaries (enforced in code, covered by tests)

1. The glasses app talks only to the PULSE API. It holds no exchange credentials and cannot reach Binance.
2. Only `BinanceSpotTestnetAdapter` holds Binance credentials, only through env, and only the `ALLOWED_ENDPOINTS` list is reachable (no withdraw / transfer / margin / futures). Any non-testnet URL fails env validation *and* adapter construction.
3. The LLM receives a bounded context of verified facts (never credentials) and returns JSON that is validated: evidence references must be items the backend supplied, numbers in facts must exist in that context. It has no tool that places orders; a suggested trade is just a *request* that goes through `TradingService.prepare`.
4. `APPROVE_TRADE` / `REJECT_TRADE` come only from the deterministic parser; model-produced approvals are discarded.
5. The execute route accepts no trade parameters; it runs the stored, approved snapshot.

## Trade lifecycle

```text
prepare  -> validate symbol/filters/balance, quote from exchange, store PENDING_APPROVAL
            (hash = SHA-256 over user, session, symbol, side, type, qty|quote, price, environment, expiry)
approve  -> client echoes the hash it DISPLAYED; backend checks owner, session, status, expiry, environment,
            recomputed hash; CAS PENDING_APPROVAL -> APPROVED; writes trade_approvals (one per proposal)
execute  -> Idempotency-Key; re-verify approval snapshot; revalidate filters/balance/price drift (>1% => new
            quote + new approval); CAS APPROVED -> SUBMITTING; insert exchange_orders row (unique per
            proposal) BEFORE calling Binance; one POST /api/v3/order with newClientOrderId
result   -> status derived ONLY from Binance's response; timeout/5xx => UNKNOWN => lookup by client order id:
            found => real state; "order does not exist" (-2013) => safe FAILED; unreachable => stays UNKNOWN
            ("Order status is being verified."), never resubmitted
```

Status machine (backend-enforced): `PENDING_APPROVAL -> {APPROVED, REJECTED, EXPIRED}`, `APPROVED -> {SUBMITTING, EXPIRED, FAILED}`, `SUBMITTING -> {SUBMITTED, PARTIALLY_FILLED, FILLED, FAILED, UNKNOWN}`, `SUBMITTED -> {PARTIALLY_FILLED, FILLED, FAILED}`, `UNKNOWN -> {SUBMITTED, PARTIALLY_FILLED, FILLED, FAILED}`. The PRD's DRAFT/VALIDATING states occur inside one `prepare` call and are not persisted.

Duplicate-order defences (layered): state-machine CAS, per-proposal unique `exchange_orders.proposal_id`, unique `client_order_id`, idempotency records (unique per user+key+operation), deterministic client order id per proposal.

## Neon and the HTTP driver

`@neondatabase/serverless` over HTTP has no interactive transactions, so no state change relies on one: each is a single atomic `UPDATE ... WHERE status = <expected> RETURNING` or a unique-index-guarded `INSERT`. DB calls have a 15 s timeout; read queries retry on transport failure, writes retry only when the request provably never left the machine.

**Latency note.** From Nigeria to the us-east-2 Neon project each query is ~250 ms. Hot paths run independent reads in parallel and audit writes are non-blocking, but the real fix is to host the API in the same region as Neon (a Node host in AWS us-east-2 / "Ohio"). See "Deployment".

## Voice

Mic (SDK `audioControl`, 16 kHz PCM) -> buffered on the phone -> `POST /agent/transcribe` -> text -> `POST /agent/message`. Because the glasses have no speaker, every answer is rendered as text. A typed transcript path (companion panel) runs through the *same* pipeline and is the fallback when no STT provider is configured or the simulator provides no audio. Voice states: IDLE, LISTENING (15 s max), PROCESSING (30 s timeout, cancellable), RESPONDING, AWAITING_APPROVAL, ERROR; repeated submissions while PROCESSING are ignored.

## Deployment (recommendation, not yet deployed)

- API: any Node 22/24 host with HTTPS and secrets, **co-located with Neon (us-east-2)**. Plain REST only (no WebSocket needed), request timeout > 30 s. Render (Ohio) web service fits.
- Glasses bundle: static build packaged into the `.ehpk` (`npm run pack:ehpk`) or any static host; set `VITE_API_URL` at build time and list that HTTPS origin in `apps/glasses/app.json` `network.whitelist` (http only for LAN dev).
- The simulator demo works fully local (API + Vite on localhost).
