# Hackathon compliance

Source of truth: <https://dorahacks.io/hackathon/even-realities/detail>, read in full on 2026-11-24 (page text captured, not summarised from a third party). "Heads Up: Even Realities Hackathon" by TVM Ventures x Daos Hub. Track entered: **03 Exchanges & Stocks** (Binance).

| # | Official requirement | Source | PULSE response | Evidence | Unresolved |
|---|---|---|---|---|---|
| 1 | Judging: Usefulness on G2 30%, Read and write 25%, Technical execution 20%, UX for display and voice 15%, Business potential and safety 10% | page, "Judging" | Product is built around those five: one glanceable thing per screen, voice + gesture, a real read path and a real approved write path, tests, safety-first design | The weights match the earlier summary exactly (verified). Screens: `apps/glasses/src/screens`; flows: [DEMO_SCRIPT.md](DEMO_SCRIPT.md) | - |
| 2 | "Build your core integration on the apps listed in your track" (Exchanges & Stocks: Binance, OKX, Bybit, Coinbase, Interactive Brokers) | page, "Tracks" and "Rules" | Core integration is Binance (Spot Testnet): market data, signed account reads, orders | `apps/api/src/modules/exchange`; live tests `apps/api/tests/binance.live.test.ts` | - |
| 3 | "On top of that, you can add any other tools (for example an LLM for reply drafts or speech-to-text)" | page, "Rules" | An LLM is an optional supporting service behind an adapter, with a deterministic fallback; STT likewise. Exchange functionality never depends on either | `apps/api/src/modules/ai/providers.ts`, `stt.ts`; tests prove the product works with no provider | The wording permits an LLM as an extra tool but does not name specific providers (Claude/ChatGPT are listed under track 04 as *core integration* apps). **Ask the organisers to confirm** (suggested message below). No provider is claimed as "approved" |
| 4 | Second track optional (up to 2) | page, "Tracks" | Not entered. PULSE does not integrate apps from other tracks | - | - |
| 5 | "Demos use testnet, paper trading or read-only data. Do not hold user funds. No financial advice. Never commit API keys or secrets." | page, "Rules" | Binance Spot **Testnet** only (URL allow-list refuses anything else), no custody, no advice (answers are verified facts + labelled interpretation), secrets only in git-ignored `.env` | `apps/api/src/modules/exchange/guard.ts`; `tests/unit.test.ts` "testnet-only enforcement"; `.gitignore`; [SECURITY.md](SECURITY.md) | Before pushing, run a secret scan of the repo history (see SECURITY.md) |
| 6 | Submission: public GitHub/GitLab/Bitbucket repo with a README explaining setup | page, "What to submit" | README with setup, scripts, structure | `README.md` | Repo must be pushed public by the team |
| 7 | Demo video of up to 3 minutes, in the simulator or on G2 | page, "What to submit" | Scripted 3-minute run | [DEMO_SCRIPT.md](DEMO_SCRIPT.md) | **Video not recorded** (done by the team) |
| 8 | Short description: problem, who it is for, how it works, track | page, "What to submit" | Draft below | this file | Paste into DoraHacks |
| 9 | "Say in your README what existed before Nov 23" | page, "Rules" | Nothing in this repo predates Nov 23, 2026; only open-source libraries and public APIs | `README.md` ("What existed before Nov 23") | - |
| 10 | Optional: packaged `.ehpk`; optional feature requests (up to 5) | page, "What to submit" | `npm run pack:ehpk`; feature requests below | `package.json` script | Package id `com.pulseg2.pulse` is a placeholder; availability check needs `evenhub login` |
| 11 | Build week Nov 23-29; deadline **Nov 29, 23:59 Dubai (GMT+4)** = 19:59 UTC (page widget shows 20:59 UTC+1, same instant) | page, "Schedule" and timeline | - | - | - |
| 12 | Teams of 1-4, one team per person; up to 2 projects | page, "Rules" | One project | - | - |
| 13 | Use a backend; whitelist external calls in `app.json`; never ship API keys in the app; Google sign-in does not work in the WebView; bring your own STT | page, "Build for G2" | Fastify backend; manifest whitelists the backend origin only; no keys in the bundle; pairing-code sign-in (no Google); STT through the backend | `apps/glasses/app.json`; `apps/api` | **Whitelist is `http://localhost:8787` for the simulator.** A real-device test needs a public HTTPS backend origin in `app.json` |
| 14 | Restrictions on AI-generated work / third-party services | page | The page states none beyond "respect the terms of the services you integrate" | - | Binance Spot Testnet terms of use are in the Binance docs repo (`testnet/TESTNET-TERMS-OF-USE.md`); not reviewed in full |
| 15 | Required packaging / deployment | page | None required; `.ehpk` optional | - | - |

## Suggested question for the organisers (hackathon chat)

> We are entering Track 03 (Exchanges & Stocks) with Binance as the core integration. We use an LLM API only as a supporting backend service for explanations and intent parsing (the exchange flow works without it). Please confirm this is acceptable for the track.

## Draft description (for the submission form)

**Problem.** Crypto traders cannot safely look at their account or act during the day without pulling out a phone, and "trading by voice" is dangerous without hard guardrails.
**For whom.** Active traders who want a glanceable, hands-free view of their account and a safe way to act.
**How it works.** PULSE runs on Even G2 (display + tap + voice). Verified Binance data is read through a backend; an optional LLM only explains it. A spoken trade becomes a proposal the backend validates and binds to exact terms; nothing is sent until the wearer explicitly approves that exact proposal on the glasses, and the result shown is what Binance confirmed.
**Track.** 03 Exchanges & Stocks, Binance Spot Testnet.

## Feature requests for the Even / Binance teams (optional section)

1. Even SDK: expose the audio source/status in `audioEvent` consistently between simulator and device; document the whitelist behaviour for WebSockets.
2. Even simulator: emit `textEvent` vs `sysEvent` consistently for clicks (we handle both).
3. Binance Spot Testnet: a documented way to reset to a clean, sparse balance set (the default account holds 500+ mostly junk assets).
4. Binance docs site: `developers.binance.com` was unreachable from some networks; the GitHub mirror was the only reliable source.
