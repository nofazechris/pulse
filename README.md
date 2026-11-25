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
Copy-Item apps/api/.env.example apps/api/.env      # fill it in (see below)
npm run db:migrate                                  # creates the 14 tables in Neon
npm run db:check                                    # one query against Neon
```

`apps/api/.env` (git-ignored; never commit it):

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Neon **pooled** connection string (Neon Console -> Connect) |
| `DATABASE_DIRECT_URL` | Neon direct string, used only by migrations |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | Testnet key only. URLs are fixed to the testnet and validated |
| `SESSION_SECRET` | >= 32 random characters |
| `PAIRING_CODE` | >= 8 characters; the code you enter (or auto-use in dev) to pair a device |
| `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL` | Optional. `anthropic` or `openai`; blank = deterministic |
| `STT_PROVIDER`, `STT_API_KEY` | Optional. `openai` (Whisper-compatible); blank = type instead of speak |

For a zero-typing simulator: copy `apps/glasses/.env.development.example` to `apps/glasses/.env.development.local` and set `VITE_DEMO_PAIRING_CODE` to your `PAIRING_CODE` (dev server only; never included in a build).

## Run

```powershell
npm run dev            # API on :8787 and the glasses dev server on :5173
npm run simulator      # Even Hub simulator pointed at :5173 (second terminal)
npm run simulator:auto # same, with the headless control API on :9898 (screenshots/input)
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
| `npm run simulator` / `simulator:auto` | Even Hub simulator |
| `npm run pack:ehpk` | build + `evenhub pack` -> `pulse.ehpk` |

## Safety

Testnet only (any other URL refuses to start). No withdrawals, deposits, futures, margin or leverage (the endpoints are not reachable). No autonomous execution: nothing is sent without an explicit approval of the exact proposal shown on the glasses, re-validated by the backend. The LLM never holds exchange credentials and can neither approve nor execute. Results shown are what Binance confirmed. Not financial advice. Details and limitations (demo-grade pairing, single shared testnet credential): [docs/SECURITY.md](docs/SECURITY.md).

## Known limitations

- Verified in the Even Hub simulator only; no physical G2 was available. Microphone audio and real LLM/STT providers are implemented but depend on keys/hardware.
- Neon is ~250 ms per query from some regions; host the API next to the Neon region for a snappy demo ([ARCHITECTURE](docs/ARCHITECTURE.md)).
- `app.json` whitelists `http://localhost:8787` for the simulator; a real-device build needs a public HTTPS backend origin.
- `binance.com` / `developers.binance.com` may be unreachable on some networks; only `testnet.binance.vision` is needed.

## What existed before Nov 23

Nothing. This repository was created on 2026-11-24; only open-source libraries (see `package.json`) and public APIs are used.
