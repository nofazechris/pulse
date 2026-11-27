# PULSE - Project record (Stage 1 decisions + Stage 2 status)

Last updated: 2026-11-24. Sources are cited inline. Anything not verified is marked **UNVERIFIED**.

## 1. Product

PULSE - "Your financial world, at a glance." Voice-first financial intelligence copilot for Even Realities G2.
Hackathon: **Heads Up: Even Realities Hackathon** (TVM Ventures x Daos Hub), DoraHacks.
Track: **03 Exchanges & Stocks** (Binance). Environment: currently running on **Binance Spot Testnet**.

## 2. Official competition rules

Source of truth: <https://dorahacks.io/hackathon/even-realities/detail> (read 2026-11-24).

| Item | Official statement |
|---|---|
| Format | 7-day online hackathon, build week Nov 23-29, 2026, teams of 1-4, worldwide |
| Prize pool | $10,000 USDT (+ up to 10 pairs of G2). Grand $2,000; 1st per track $1,250; 2nd per track $375; Best Telegram $1,000; Community Partner up to $500. One cash prize per project |
| Tracks (4) | 01 Messaging & News (Telegram, Discord, Slack) / 02 Crypto & DeFi (Gram Wallet, Polymarket, Hyperliquid, Trust Wallet) / **03 Exchanges & Stocks (Binance, OKX, Bybit, Coinbase, Interactive Brokers)** / 04 AI Assistants & Work (Claude, ChatGPT, OpenRouter, Notion, Google Workspace). Special prize: Best Telegram integration (any track) |
| Second track | Optional, up to 2, only if the app genuinely connects apps from several tracks |
| Deadline | Page widget: **2026-11-29 20:59 (UTC+1)**; schedule text: **Nov 29, 23:59 Dubai (GMT+4)**. Same instant = **19:59 UTC**. Judging Nov 30 - Dec 1; Demo Day Dec 3, Dubai (remote allowed) |
| Submit | Public GitHub/GitLab/Bitbucket repo with README explaining setup; demo video **up to 3 min** (simulator or G2); short description (problem, who, how, track). Optional: up to 5 API feature requests, packaged `.ehpk` |
| Existing code | "Build during the hackathon. Open-source libraries and existing APIs are allowed; say in your README what existed before Nov 23." |
| Tools | "On top of that, you can add any other tools, like an LLM for reply drafts or speech-to-text." |
| Money safety | "Demos use testnet, paper trading or read-only data. Do not hold user funds. No financial advice. Never commit API keys or secrets." |
| Other | Respect service terms and privacy; organisers may disqualify rule-breakers. Backend required for external calls (whitelist + CORS); never ship API keys in the app; Google sign-in does not work in the WebView; bring your own speech-to-text |

### Judging (verified, matches the earlier summary exactly)

1. Usefulness on G2 - **30%** (real everyday moment, at a glance, hands-free)
2. Read and write - **25%** (fast act: short phrase, one tap or ring, smart defaults / AI drafts)
3. Technical execution - **20%** (end to end, reliable, clean code)
4. UX for display and voice - **15%** (clear on 576x288 monochrome, natural by voice)
5. Business potential and safety - **10%** (real users and demand, careful with data and money)

### Track eligibility assessment

- **Binance** is explicitly listed in Exchanges & Stocks: eligible as the core integration.
- **External LLM**: the official text allows adding "any other tools, like an LLM" on top of the track's core integration. Claude/ChatGPT being listed under track 04 concerns building the *core integration* on those apps; using an LLM API as a supporting backend service is permitted by the wording. It is not an explicit ruling on named providers, so we still **recommend a one-line confirmation in the hackathon chat** (see Open questions). The adapter + deterministic fallback keeps us safe either way.
- **Speech-to-text** is explicitly named as an allowed extra tool.
- Margin: the track blurb uses a spot-to-margin example, but PULSE excludes margin/futures/leverage by our own safety rules. No conflict.
- No second track needed.

## 3. Hardware & SDK capabilities (verified from Even Hub docs + SDK 0.0.16 typings)

Sources: hub.evenrealities.com/docs `get-started/overview`, `build/display`, `build/device-apis`, `build/networking`, `test/simulator`, `ship/packaging`, `cli/*`; `node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts`.

- Display 576x288 per eye, 4-bit greyscale (16 green levels), origin top-left. No HTML/CSS/DOM on the glasses: absolute-positioned **containers** (text, list, image). One font, no size/bold/italic/alignment control; unsupported glyphs silently dropped (use ASCII).
- Limits: <= 8 non-image + <= 4 image containers/page (docs); typings say `containerTotalNum` 1-12. Exactly one container with `isEventCapture: 1`. Text: 1000 chars on create/rebuild, 2000 on `textContainerUpgrade`; full screen ~400-500 chars. List: <= 20 items x 64 chars. Image: <= 288x144, cannot be sent at create time. `textColor` brightness 0-4.
- Input: press (click), double press, swipe up / down (scroll events), long press + release (SDK 0.0.14+). R1 ring has the same gestures (`eventSource` distinguishes).
- **Microphone: yes.** `bridge.audioControl(true, AudioInputSource.Glasses|Phone)`; PCM 16 kHz signed 16-bit LE mono delivered as `event.audioEvent.audioPcm` (Uint8Array), ~100 ms chunks. Manifest permission `g2-microphone` (or `phone-microphone`). STT is ours to provide.
- **No camera, no speaker, no background execution/notifications.** One app at a time; nothing shows when the user switches away.
- Network: two gates - manifest `network.whitelist` (full origins, https in production, http only for LAN dev) **and** browser CORS. Whether the whitelist covers WebSockets: **UNVERIFIED**.
- Persistence on device: `setLocalStorage`/`getLocalStorage` exist; PULSE memory lives in Neon via the backend.
- Manifest (`app.json`) fields: `package_id, edition ("202601"), name (<=20), version (x.y.z), min_app_version (derived), min_sdk_version, entrypoint, permissions[] ({name, desc, whitelist?}), supported_languages`. Valid permission names (exactly 6): `network, location, g2-microphone, phone-microphone, album, camera`.

## 4. Verified environment & decisions

| Item | Result |
|---|---|
| OS | Windows 11 Pro 10.0.26200 |
| Node | **v24.15.0** (preferred was 22 LTS; every engines range below accepts 24) |
| npm | 12.0.1 (blocks dependency install scripts by default; esbuild/tsx/vite worked anyway) |
| Git | 2.54.0.windows.1; repo initialised, **nothing committed** |
| Existing PULSE project | None (folder was empty) |
| Pre-existing globals | `@evenrealities/evenhub-cli@0.2.0`, `@evenrealities/evenhub-simulator@0.9.5` (same versions pinned locally). A global `supabase` CLI also exists on this machine; it is **not used** and PULSE has no Supabase dependency anywhere |
| Engines | SDK `^20 \|\| >=22`; CLI `^20.17 \|\| ^22.13 \|\| >=23.5`; Vite 8 `^20.19 \|\| >=22.12`; Vitest 5 `^22.12 \|\| ^24 \|\| >=26`; Neon driver `>=19`. Repo `engines`: `^22.13.0 \|\| ^24.0.0` |
| TypeScript | Pinned **5.9.3**, not the newest 7.0.2 (native rewrite, too new for Vite/drizzle-kit/CLI peer `typescript ^5`). Revisit after the hackathon |
| `@types/node` | 24.19.2 (matches runtime major) |
| Repo layout | npm workspaces: `apps/glasses`, `apps/api`, `packages/shared` |
| Package id | `com.pulseg2.pulse` is a **placeholder** (rules: lowercase reverse-domain, no hyphens). Availability check needs `evenhub login` |

Fixed architecture (unchanged): Vite + React + TS; Even Hub SDK/simulator/CLI; Fastify + Node + TS; Neon + `@neondatabase/serverless` + Drizzle + Drizzle Kit; Zod; Pino; Vitest; external LLM behind an adapter with deterministic fallback; Binance Spot Testnet. **Neon is the only database. No Supabase.**

Safety invariants (carry into Stage 2): runs on testnet today (any other exchange URL is refused); no withdrawals/deposits/futures/margin/leverage; no autonomous execution; the LLM never holds Binance credentials; backend re-validates every operation; each proposal bound to user + session + symbol + side + type + quantity/quote amount + environment + expiry; any parameter change needs fresh approval; idempotent submission; no fabricated balances, prices or confirmations.

## 5. Binance Spot Testnet (partially verified)

Verified from the official repo `binance/binance-spot-api-docs` (`testnet/general-info.md`, `testnet/rest-api.md`):
- REST base: `https://testnet.binance.vision/api` (alt `https://api1.testnet.binance.vision/api`)
- WebSocket API: `wss://ws-api.testnet.binance.vision/ws-api/v3`; streams: `wss://stream.testnet.binance.vision`
- Keys are created at <https://testnet.binance.vision> (log in, generate API key); signed requests send `X-MBX-APIKEY`, `timestamp`, `recvWindow`, `signature`.
- Endpoints exist: `New order (TRADE)`, `Test new order (TRADE)`, `Query order (USER_DATA)`, `24hr ticker`, `Symbol price ticker`.

**Credentials verified live (2026-11-24, read-only, no order placed):** a signed `GET /api/v3/account` with the supplied HMAC key returned HTTP 200 (`accountType SPOT`, `canTrade true`, `permissions ["SPOT"]`); public `GET /api/v3/ticker/price` works. From this machine `testnet.binance.vision` is reachable while `binance.com`, `api.binance.com` and `developers.binance.com` time out (network-level block), so **only the testnet host is usable here**; `api1.testnet.binance.vision` does not resolve - use the primary host.

**Testnet data caveats for Stage 2 design:**
- The account holds **500+ assets**, many junk/odd symbols (e.g. non-Latin names, "456"), with arbitrary fake amounts. "Biggest holding" must be computed by USDT valuation over a vetted set of quote pairs, not by raw amount.
- Testnet prices are **not mainnet prices** (BTCUSDT was 59,980.00 at check time). Every price shown must be labelled TESTNET so we never present it as real-market data.
- The key reports `canWithdraw/canDeposit true` (testnet default). PULSE never calls those endpoints; enforce this in the adapter with an endpoint allow-list.

**UNVERIFIED (read in Stage 2 before coding the adapter):** exact parameter rules for MARKET orders with `quoteOrderQty`, symbol filters (min notional, lot size), account/openOrders response shapes, testnet reset cadence. `developers.binance.com` timed out from this machine (ECONNRESET / 300 s browser timeout), so only the GitHub mirror was read.

## 6. Smoke-test results (all executed 2026-11-24)

| # | Required outcome | Result |
|---|---|---|
| 1 | Vite app starts | PASS - `npm run dev:glasses` serves on :5180 (HTTP 200 for `/`, `/src/main.tsx`, `/src/glasses/smoke.ts`) |
| 2 | Even Hub SDK imports | PASS - `tsc` clean; bridge initialised in simulator (`[EvenAppBridge] Bridge initialized`) |
| 3 | Simulator launches | PASS - `evenhub-simulator 0.9.5` with `--automation-port 9898`, `/api/ping` -> `pong` |
| 4 | Text renders at G2 size | PASS - 576x288 screenshot `docs/smoke/01-initial.png` |
| 5 | Monochrome respected | PASS - green-on-black only; companion panel also green/black |
| 6 | Interaction | PASS - click x2, double click, swipe up/down, long press all received and rendered (`docs/smoke/02-after-input.png`). Observed: simulator delivers click/double/long-press as `sysEvent` and swipes as `textEvent`; handler accepts both and treats missing `eventType` as click |
| 7 | Backend starts independently | PASS - `npm run dev:api`, `GET /health` 200; helmet + CORS + rate-limit active |
| 8 | Neon configurable via `DATABASE_URL` | PASS (config path) - zod-validated, empty = unconfigured; `/health/db` returns 503 `unconfigured` |
| 9 | Test DB query | PASS (2026-11-24, after credentials supplied) - `npm run db:check` -> `Neon OK: database "neondb"`; `neon.live.test.ts` now runs and passes (11/11 tests) |

Also: `npm run typecheck` clean; `npx vitest run` 10 passed / 1 skipped (live Neon); `npm run build` OK; `evenhub pack` accepted the manifest (128,847 byte `.ehpk`, `min_app_version 2.2.10`; test file deleted). The glasses panel fetched `/health` from the API inside the simulator WebView (`API ... ok`), proving CORS works; whether the simulator *enforces* the manifest whitelist was **not tested**.

Not exercised in Stage 1: microphone capture (simulator lists one input, "Microphone (default)"), Binance, any LLM, real device.

## 7. Open questions / outstanding

1. **LLM eligibility** - ask in the hackathon chat: "Track 03 team using an LLM API as a supporting backend service (intent parsing / explanations) - confirm that is fine?" Official text already says any extra tool is allowed.
2. ~~Neon~~ - DONE: connected and queried successfully.
3. ~~Binance Testnet key~~ - DONE: key verified read-only. Not yet wired into code (Stage 2); env schema does not parse `BINANCE_TESTNET_*` yet.
4. **LLM provider** (Stage 2 PRD) and **speech-to-text provider** (e.g. Whisper-class) - not chosen; both sit behind adapters.
5. **Hosting** - needs decision. Suggested: Fastify on a Node host with HTTPS (e.g. Render or Fly) and the glasses bundle either loaded from the same host or packaged as `.ehpk`. Required before any real-device test; the simulator demo works locally. Then replace the `localhost:8787` entry in `app.json` `network.whitelist` with the HTTPS origin.
6. **Package id / app icon** - confirm `com.pulseg2.pulse`; icon must be 24x24 PNG, pixels transparent or `#F4F4F4`, 2x2 blocks (only needed for listing/upload).
7. Timeline: submission closes **Nov 29, 23:59 Dubai** (19:59 UTC); 5 days remain at time of writing.

## 8. README disclosure (rule: state what existed before Nov 23)

Nothing in this repository existed before Nov 23, 2026; the project directory was empty on 2026-11-24. Only open-source libraries (listed in `package.json`) and public APIs are used.

---

# Stage 2 status (technical PRD implementation) - updated 2026-11-26

**Added 2026-11-26 (scoring features):** trade plans (voice alerts that arrive with a prepared order; never trade alone), session P&L, smart default buy amounts; glasses dev port moved to **5180** (another local project uses 5173); video pipeline with AI voiceover (`scripts/record-demo.mjs`, `scripts/make-voiceover.mjs`). 271 tests pass; a no-server practice mode (labelled DEMO) is built into the app and was walked through in the simulator; final video `demo-video/pulse-demo.mp4` (2:56, includes one spoken request transcribed live, a sell of half the balance and a confirmed cancellation) recorded in the simulator.

Implemented per the PRD and documented in [ARCHITECTURE](ARCHITECTURE.md), [API](API.md), [DATABASE](DATABASE.md), [SECURITY](SECURITY.md), [TESTING](TESTING.md), [HACKATHON_COMPLIANCE](HACKATHON_COMPLIANCE.md), [DEMO_SCRIPT](DEMO_SCRIPT.md). Stage 1 sections below are kept as history; where they differ (API port, env names, file layout) this section wins.

## Verified (actually run)

| Area | Evidence |
|---|---|
| Database | 14-table Drizzle migration applied to Neon; all DB-backed suites run against it |
| Binance Testnet read | live tests: server time, exchange info + filters, ticker, 24h stats, bulk prices, signed account (517 balances), open orders, bad signature rejected |
| Binance Testnet write | live tests and the panel flow placed small testnet orders through prepare -> approve -> execute and verified them independently on Binance by client order id (market BUY filled and confirmed; resting LIMIT BUY accepted as NEW, then cancelled by id) |
| Trade safety | `trade-safety.test.ts`: every PRD 17.3 item (no execution without approval, expiry, ownership, changed parameters, duplicates and concurrency, timeouts reconciled without resubmission, invalid symbol/balance/precision, LLM cannot bypass, model text cannot mark success, testnet-only) |
| Journeys A-E | `journeys.test.ts` (session, portfolio, grounded market answers, trade, persistent memory) |
| Glasses UI in the official simulator | Real testnet data on Home, Portfolio, Market and Watchlist; listening screen with "MIC ON"; screenshots `docs/smoke/10-*.png` ... `22-*.png`. Cold start to Home takes ~12-15 s from Nigeria (network latency) |
| Microphone | The simulator opens the mic on `audioControl` and delivers PCM frames (`audioEvent`); PULSE buffers them and posts them to `/agent/transcribe` |
| Full conversational trade in the panel | "buy 20 usdt of btc" -> proposal (TESTNET, REJECT preselected) -> swipe to APPROVE -> tap -> ORDER RESULT CONFIRMED, Binance order id shown |
| Packaging | `npm run pack:ehpk` works (143,708 bytes); the production bundle contains neither the pairing code nor any key |
| Static | strict `tsc` clean on all workspaces |

## Bugs found by testing and fixed

The 2 s price cache could hide a price jump just before execution (proposals and the pre-execution drift check now always use a fresh quote; regression test added); Neon HTTP connections timing out from this network (dedicated keep-alive pool, short connect timeout, read-only retry; writes only retried when the request never left); duplicate session on dev auto-pair; 401 during a voice request not returning to pairing; pairing instruction cut off the connection screen; lower-cased memory text; mismatched voice-approve dropping the proposal screen; approved order that failed before confirmation now offers a retry of the SAME order (same approval, same idempotency key); API port 3000 clashed with another project, so the default is now **8787**.

## Not verified / limits (read these)

- **No physical G2.** Everything above is simulator + automated tests. The Even app whitelist/CORS on a device is untested.
- **LLM and speech-to-text: live-verified 2026-11-26** (OpenAI `gpt-6-luna` + `gpt-transcribe`, the cheapest current models per OpenAI's pricing page). 8 synthesised spoken commands were transcribed through `/agent/transcribe` (~1 s each) and acted on; grounded AI answers took ~3-5 s; injection-style requests produced no approval and no order. Fixed along the way: spoken "Approve." (trailing full stop), spoken numbers ("fifty dollar"), "should I buy...?" treated as a trade, model evidence values rejected for length, bracketed references, and the invented-number check extended to every visible line. **Still not tested:** a person speaking into the simulator/G2 microphone with live speech-to-text.
- WebSocket market stream (PRD 8.8) is **not built**: REST polling only.
- Auth is demo-grade pairing with one shared testnet credential ([SECURITY](SECURITY.md)); `exchange_connections` is unused.
- Voice can list open orders and select one to cancel; the cancellation itself is confirmed on the lens. Checked live on testnet on 2026-11-26: resting limit buy, list, cancel, a 1% market sell and a watcher hit.
- Portfolio total is "USDT value of priced assets"; unpriced testnet junk assets are excluded and counted, never added to the total.
- Latency: ~250-300 ms per Neon query from Nigeria (us-east-2). Host the API near Neon for a snappy demo.

## Remaining for submission (yours)

1. Pick/confirm the package id; `evenhub login` + `pack --check` if you want a listing.
2. Ask the organisers the LLM question ([HACKATHON_COMPLIANCE](HACKATHON_COMPLIANCE.md)); optionally add LLM/STT keys and test them.
3. Optionally deploy the API (Render Ohio recommended) and put its HTTPS origin in `apps/glasses/app.json`.
4. Video uploaded: <https://www.youtube.com/watch?v=B5mK4iPqPEI> (see [DEMO_SCRIPT](DEMO_SCRIPT.md)); the repository is public at <https://github.com/nofazechris/pulse>; submit before **Nov 29, 23:59 Dubai (19:59 UTC)**.
