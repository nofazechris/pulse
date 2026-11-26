# PULSE

**Your financial world, at a glance.** A voice-first financial copilot for Even Realities G2 smart glasses.
Heads Up: Even Realities Hackathon 2026 - track **Exchanges & Stocks** - Binance **Spot Testnet only**.

PULSE reads your Binance Spot Testnet account and markets, answers questions from verified data, and lets you prepare and **explicitly approve** testnet trades from the glasses. It is not a chatbot and not a dashboard squeezed onto a wearable: one thing per screen, voice and tap, and every number comes from the exchange.

> **AI interprets. Verified services retrieve data. The backend validates. The user authorizes. Binance executes.**

## What works

- Glasses app (Vite + React + TS, official Even Hub SDK) with screens for connection, home, portfolio, market, watchlist, AI insight, trade proposal and execution result, sized for 576x288 monochrome green.
- Voice pipeline (mic -> backend STT -> intent -> verified data -> display) with a typed-transcript fallback that uses the same path; gesture navigation validated against the simulator.
- Backend (Fastify, Zod, Pino) over Binance Spot Testnet: public market data, signed account data, portfolio valuation, watchlist, orders.
- Trade flow: proposal -> exact-terms approval -> idempotent execution -> reconciliation; cancel by id.
- Persistent memory, preferences, sessions, audit log in **Neon PostgreSQL** (Drizzle).
- Replaceable AI provider (Anthropic / OpenAI-compatible) and STT provider, each with a deterministic fallback.

See [docs/PROJECT.md](docs/PROJECT.md) (decisions, rules, status), [ARCHITECTURE](docs/ARCHITECTURE.md), [API](docs/API.md), [DATABASE](docs/DATABASE.md), [SECURITY](docs/SECURITY.md), [TESTING](docs/TESTING.md), [HACKATHON_COMPLIANCE](docs/HACKATHON_COMPLIANCE.md), [DEMO_SCRIPT](docs/DEMO_SCRIPT.md).

## Layout

```
apps/glasses     Even Hub app: sdk adapters, typed API client, controller, screens, companion panel, app.json
apps/api         Fastify API: exchange, market, portfolio, trading, agent, ai, memory, sessions, db, security
packages/shared  zod contracts, exact decimal maths, formatting, G2 display facts
docs/            documentation + smoke-test screenshots
```

## Requirements

Node 22.13+ or 24 (developed on 24.15), npm, Git. A free [Neon](https://neon.com) project and a [Binance Spot Testnet](https://testnet.binance.vision) API key (log in with GitHub; HMAC key). LLM and STT keys are optional.

## Setup

```powershell
npm install
# create apps/api/.env from the template below, then:
npm run db:migrate                                  # creates the 14 tables in Neon
npm run db:check                                    # one query against Neon
```

Create `apps/api/.env` (git-ignored; never commit it) and fill in the blank values:

```
NODE_ENV=development
HOST=0.0.0.0
API_PORT=8787
API_BASE_URL=http://localhost:8787
LOG_LEVEL=info
CORS_ORIGIN=http://localhost:5173

DATABASE_URL=
DATABASE_DIRECT_URL=

BINANCE_ENV=testnet
BINANCE_TESTNET_REST_URL=https://testnet.binance.vision/api
BINANCE_TESTNET_STREAM_URL=wss://stream.testnet.binance.vision/stream
BINANCE_API_KEY=
BINANCE_API_SECRET=

SESSION_SECRET=
SESSION_TTL_MINUTES=120
PAIRING_CODE=

PROPOSAL_TTL_SECONDS=120
PRICE_MOVE_TOLERANCE_PERCENT=1
DEMO_MODE=false
```

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Neon **pooled** connection string (Neon Console -> Connect) |
| `DATABASE_DIRECT_URL` | Neon direct string, used only by migrations |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | Testnet key only. URLs are fixed to the testnet and validated |
| `SESSION_SECRET` | >= 32 random characters |
| `PAIRING_CODE` | >= 8 characters; the code you enter (or auto-use in dev) to pair a device |
| `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL` | Optional. `anthropic` or `openai`; blank = deterministic |
| `STT_PROVIDER`, `STT_API_KEY` | Optional. `openai` (Whisper-compatible); blank = type instead of speak |

For a zero-typing simulator, create `apps/glasses/.env.development.local` (git-ignored; dev server only, never included in a build) with:

```
VITE_API_URL=http://localhost:8787
VITE_DEMO_PAIRING_CODE=<the same value as PAIRING_CODE>
```

## Optional: LLM and voice (speech-to-text)

PULSE works without either (deterministic parser, typed input). To switch them on, add to `apps/api/.env` (never to chat, git or the frontend), then restart `npm run dev` (`.env` is read at start-up) and run `npm run ai:check`:

```
# One OpenAI key powers both (the cheapest current models, Nov 2026):
AI_PROVIDER=openai
AI_API_KEY=<your key>
AI_MODEL=gpt-6-luna
STT_PROVIDER=openai
STT_MODEL=gpt-transcribe
# STT_API_KEY may stay blank: the AI key is reused
# Anthropic instead for the LLM: AI_PROVIDER=anthropic, AI_API_KEY=<key>, AI_MODEL=<model id>
# OpenAI-compatible server: AI_BASE_URL=https://.../v1   (STT_BASE_URL likewise)
```

`npm run ai:check` makes one tiny real call per configured service and prints OK or FAILED with the reason (never the key). What a model sees: a few verified facts (e.g. a price, your portfolio total), your explicit memory notes and preferences, and your question. It never sees credentials, account ids or order history, and it cannot approve or place trades. Please ask the organisers to confirm LLM use ([HACKATHON_COMPLIANCE](docs/HACKATHON_COMPLIANCE.md)).

## Run

```powershell
npm run dev            # API on :8787 and the glasses dev server on :5173
npm run simulator      # Even Hub simulator pointed at :5173 (second terminal)
npm run simulator:auto # same, with the headless control API on :9898 (screenshots/input)
npm run demo           # simulator + scripted demo autopilot with an on-screen teleprompter (for recording the video)
```

Open <http://localhost:5173> in a normal browser to use the companion panel with an in-memory adapter (no simulator needed).

## Scripts

| Script | Does |
|---|---|
| `npm run dev` / `dev:api` / `dev:glasses` | development servers |
| `npm run build` | build the glasses bundle + typecheck the API |
| `npm run typecheck` | strict TypeScript across all workspaces (there is no ESLint; strict `tsc` is the static check) |
| `npm test` | unit + database-backed safety/journey tests (needs Neon; uses a fake exchange) |
| `npm run test:integration` | live Binance **Testnet** + Neon tests, including real small testnet orders through the approval flow |
| `npm run db:generate` / `db:migrate` / `db:studio` / `db:check` | Drizzle Kit and a Neon check |
| `npm run ai:check` | Verify the optional LLM / speech keys with one small call each |
| `npm run simulator` / `simulator:auto` | Even Hub simulator |
| `npm run demo` / `demo:fast` | Simulator + demo autopilot (see [DEMO_SCRIPT](docs/DEMO_SCRIPT.md)); places one small testnet order |
| `npm run pack:ehpk` | build + `evenhub pack` -> `pulse.ehpk` |

## Safety

Testnet only (any other URL refuses to start). No withdrawals, deposits, futures, margin or leverage (the endpoints are not reachable). No autonomous execution: nothing is sent without an explicit approval of the exact proposal shown on the glasses, re-validated by the backend. The LLM never holds exchange credentials and can neither approve nor execute. Results shown are what Binance confirmed. Not financial advice. Details and limitations (demo-grade pairing, single shared testnet credential): [docs/SECURITY.md](docs/SECURITY.md).

## Known limitations

- Verified in the Even Hub simulator only; no physical G2 was available. LLM (OpenAI `gpt-6-luna`) and speech-to-text (`gpt-transcribe`) were verified live on 2026-11-26 with synthesised speech; a live voice through the simulator or glasses microphone is still to be tried.
- Neon is ~250 ms per query from some regions; host the API next to the Neon region for a snappy demo ([ARCHITECTURE](docs/ARCHITECTURE.md)).
- `app.json` whitelists `http://localhost:8787` for the simulator; a real-device build needs a public HTTPS backend origin.
- `binance.com` / `developers.binance.com` may be unreachable on some networks; only `testnet.binance.vision` is needed.

## What existed before Nov 23

Nothing. This repository was created on 2026-11-24; only open-source libraries (see `package.json`) and public APIs are used.
