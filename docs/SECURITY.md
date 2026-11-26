# Security

## Money safety (hard rules, enforced in code)

- **Testnet enforced.** `BINANCE_ENV` accepts only `testnet`; REST/stream URLs must be exactly `https://testnet.binance.vision/api` / `wss://stream.testnet.binance.vision/...` (rejects look-alike hosts, userinfo tricks, ports, http, other paths). Checked in env validation *and* in the adapter/client constructors. There is no production switch.
- **Endpoint allow-list.** The Binance client can only call: ping, time, exchangeInfo, ticker price/24hr, account, openOrders, allOrders, order (GET/POST/DELETE). Withdraw, deposit, transfer, margin and futures are unreachable.
- **Trade plans cannot trade.** A plan only alerts and prepares an ordinary proposal; it has no access to approval or execution, fires once (compare-and-set), expires in 24 h, cannot replace a proposal under review, and the server watcher only records that a level was reached (tests in `plans.test.ts`, `features.test.ts`).
- **Practice mode is separate and labelled.** It starts only when the wearer chooses it, makes no network call, keeps its token in memory, and shows DEMO / SIMULATED / DEMO ORDER instead of testnet confirmations (`practice.test.ts`).
- **Cancelling is confirmed on the lens.** Speech or text can only select an open order; the app calls the cancel endpoint after a swipe and tap on that exact order (KEEP is preselected). A model can never request it. The endpoint checks ownership and that the order is still open; unlike a trade it keeps no server-side approval record.
- **No autonomous execution.** A trade needs a proposal -> explicit approval of *that exact proposal* -> execute. The LLM has no order tool; model-suggested trades are only requests to `prepare`; model approvals are discarded.
- **Approval binding.** SHA-256 over user, session, symbol, side, type, quantity|quote, price, environment, expiry. Any change invalidates the approval. Wrong session, wrong user, expired, wrong environment, tampered rows: all refused (tests 3, 3b, 4, 13).
- **Duplicate prevention.** CAS status transitions, DB unique indexes (one order per proposal, one client order id), idempotency keys, deterministic client order id, writes never auto-retried; uncertain outcomes reconcile by client order id and are never resubmitted.
- **No fabrication.** Prices, balances and results come from the exchange; unavailable data is shown as unavailable; stale data is flagged; the success message is built only from Binance's response; DEMO mode is explicit and labelled.
- **Not financial advice.** Answers are verified facts, a clearly labelled AI view, and an explicit "cannot verify why" when no news/event source exists.

## Credentials and secrets

- Binance keys live only in `apps/api/.env` (git-ignored; every `.env` and `.env.*` file is ignored). Never in the frontend bundle, prompts, logs, memory or audit rows.
- `SESSION_SECRET` (>= 32 chars) HMACs session tokens; only hashes are stored.
- Logs (Pino) redact `authorization`, `x-mbx-apikey`, `cookie`, `idempotency-key`; audit metadata redacts any key matching secret/signature/token/authorization/api key/password/cookie/pairing; Binance request signatures are never logged; error responses never include driver text.
- Memory refuses to store anything that looks like a key, password, token or seed phrase.
- Before publishing the repo run a secret scan, e.g. `git log -p | grep -iE "secret|apikey|postgres://"` and make sure `apps/api/.env` and `apps/glasses/.env.development.local` are untracked (`git status --ignored`).

## Authentication (demo-grade, documented honestly)

Lightweight device pairing: a pairing code from server env (constant-time compare, rate-limited 10/min, failures audited) links a device to the single demo user and mints a short-lived opaque token (refresh rotates; logout revokes; server keeps an HMAC only; 15 s in-process cache that logout/refresh evict). **This is not production identity**: one shared pairing code, one demo user, no per-user exchange credentials (the `exchange_connections` table is unused). The Even WebView exposes no secure enclave, so the token is kept in WebView storage and expires in 2 h; the pairing code itself is never stored. Dev-only `VITE_DEMO_PAIRING_CODE` auto-pairs the simulator and is loaded by `vite dev` only (`.env.development.local`), never by `vite build`.

## API hardening

zod validation on every input, helmet headers, CORS limited to `CORS_ORIGIN`, 64 KB body limit (20 s of PCM on the transcribe route), global and per-route rate limits, ownership checks on every resource (another user's id behaves like a missing one), safe error envelope, request ids on every response.

## Prompt injection

Model input is a bounded context of verified facts; memory notes and user text are labelled untrusted data. Output must validate against a zod schema, cite only supplied evidence references, and quote only numbers present in the context, otherwise it is discarded for the deterministic answer. Nothing in text, memory or model output can change the environment, bypass validation, or approve anything (test 11, 11b, 12).

## Known limitations

- Demo pairing and a single shared testnet credential (above).
- The in-process auth cache means a revoked token can survive up to 15 s on *another* server instance (single instance today).
- `Idempotency-Key` records are kept 24 h.
- LLM (OpenAI `gpt-6-luna`) and speech-to-text (`gpt-transcribe`) were verified live on 2026-11-26 with synthesised speech; a live human voice through the simulator or G2 microphone is still untested. Voice audio is sent to the speech provider only for the utterance being processed and is not stored by PULSE.
- With an LLM enabled, every user-visible line of its answer may only contain numbers present in the verified context; opinion requests ("should I buy?") can never become a trade.
- The Even whitelist/CORS behaviour on a physical device is untested (no glasses available).
