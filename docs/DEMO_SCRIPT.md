# Demo script (about 3 minutes, simulator)

## Easiest way: the demo autopilot (you only press record and talk)

The app can perform the whole demo by itself through the real controller (real Binance Testnet data, the real approval flow, ONE small approved testnet order). It also shows a **teleprompter** (what to say, what to point at) in the app window.

```powershell
npm run dev          # terminal 1: API on :8787 + glasses dev server on :5180
npm run demo         # terminal 2: opens the Even Hub simulator and starts the autopilot after a 5 s countdown
```

1. Wait until `npm run demo` has opened the simulator (two windows: the glasses and the app panel). The autopilot waits until the app is paired and on Home, then shows "Recording starts in 5...".
2. Start your screen recorder when you see the countdown (Windows: **Win+G** -> Capture; or OBS). Capture both simulator windows side by side.
3. Read the narration box aloud as it changes. It takes about 2 and a half minutes of app time (more on a slow connection). `npm run demo:fast` is a tighter cut. **Stop demo** aborts it.
4. You can also start it from the app panel ("Demo autopilot" -> Run demo) or open `http://localhost:5180/?autorun=1&countdown=5` in a browser (in-memory glasses preview instead of the simulator).

What it does, in order: home -> start session -> biggest holding -> a **spoken** question ("How is Bitcoin doing?", transcribed live) -> "why is it moving" (facts vs UNVERIFIED) -> arm a trade plan -> the plan fires with a prepared order -> swipe to APPROVE -> tap -> Binance-confirmed fill with order id -> session P&L -> "sell half my Bitcoin" at a price far above the market -> approve -> the order rests -> "cancel my order" -> swipe and tap -> Binance-confirmed cancellation -> remember a preference -> new session that remembers it.

Each run starts clean (it resets the demo watchlist and closes pending proposals; exchange order history is never deleted) and places exactly one testnet order. The script lives in `apps/glasses/src/demo/script.ts`; edit the wording/timing there.

The spoken step plays a synthesized clip (`apps/glasses/public/demo/wearer-btc.wav`, 16 kHz mono like the G2 microphone) into the real speech-to-text; it needs `STT_PROVIDER`/`STT_API_KEY`. The other requests are typed by the autopilot, which is the same path speech takes after transcription. You can also double-tap and speak any line yourself.

## Recording the video (how demo-video/pulse-demo.mp4 is made)

No screen capture: the exact glasses frames come from the simulator's automation API, then ffmpeg composes a 1080p video with a title card, the lens, captions, subtitles, the voiceover and a closing card.

```powershell
npm run dev                                 # terminal 1
node scripts/make-voiceover.mjs             # once, or after editing apps/glasses/src/demo/narration.json
node scripts/record-demo.mjs capture        # terminal 2 (waits for the simulator)
npm run demo:record                         # terminal 3 (simulator + autopilot)
node scripts/record-demo.mjs compose        # when capture has finished
```

The voice is AI-generated (OpenAI `gpt-4o-mini-tts`, voice "cedar"). Each take buys 20 USDT of BTC on testnet, then places a resting sell and cancels it. If a take is interrupted, check for a resting order and cancel it before the next one.

## Manual script

**Setup (once):** `apps/api/.env` filled (Neon, Binance testnet key, `SESSION_SECRET`, `PAIRING_CODE`); `apps/glasses/.env.development.local` has `VITE_DEMO_PAIRING_CODE` for auto-pair.

```powershell
npm run dev          # API :8787 + Vite :5180
npm run simulator    # Even Hub simulator (second terminal)
```

Speak the lines (or type them in the companion panel's "Talk to PULSE" box / click the chips; the glasses view is mirrored in the panel). Gestures: double-tap = talk, swipe = move, tap = select, hold = back/cancel.

| Time | Say / do | What the judge sees | Why it matters |
|---|---|---|---|
| 0:00 | Launch. | Connection screen -> Home: greeting, **portfolio value in USDT, 24h change, BTC/ETH prices**, header says TESTNET | Glanceable, real data |
| 0:15 | "Pulse, start my trading session." | Greeting built from verified data (and "Welcome back..." on later runs) | Session + memory |
| 0:25 | "What's my biggest holding?" | Portfolio screen: biggest asset and total over priced assets, "N unpriced excluded" | Real read; honest about junk testnet assets |
| 0:40 | "How is Bitcoin performing?" | Market screen: price, 24h %, high/low, age | Verified fact with freshness |
| 0:55 | "Why is Bitcoin moving today?" | Plain verified lines (facts) + `UNVERIFIED: Cannot verify why: no news source.` (AI wording may differ) | No fabricated causes |
| 1:10 | "Add SOL to my watchlist" | Watchlist with live prices/arrows | Write to Neon |
| 1:20 | "Prepare a $50 BTC buy." | **Trade proposal**: TESTNET banner, BUY BTC (BTCUSDT), 50 USDT, MARKET ~price, est. fee, `> REJECT <` preselected | Exact terms, safe default |
| 1:40 | Swipe down (selection moves to `> APPROVE <`), tap | "THINKING" then **ORDER RESULT CONFIRMED**, `BOUGHT ... BTC`, `AT ... USDT`, `BINANCE ORDER #<id>` | Approved write, exchange-confirmed |
| 2:00 | (optional) Tap approve again / say "approve" with nothing pending | Nothing happens: no duplicate order, "nothing waiting for approval" | Safety |
| 2:10 | "What happened to my last order?" | Status read back from Binance | Read after write |
| 2:25 | "Remember that I focus on BTC and ETH." then "End my session." | Saved; session summary | Persistent memory |
| 2:40 | Start a new session | Greeting: "I remember: focus on btc and eth", "Last time: 1 filled, ..." | Memory across sessions |
| 2:50 | Show the panel Diagnostics | DB, Binance testnet, AI/STT provider status, request ids | Reliability |

**Backup beats (if time):** hold during the proposal = cancel (nothing sent); a proposal left alone expires (countdown in footer); "price of dogecoin" -> honest "not listed".

**If something fails live:** `npm run db:check`; panel Diagnostics shows which service is down; `DEMO_MODE=true` gives a clearly labelled DEMO dataset (never switched on silently).

**Recording notes:** capture the simulator window and the panel's glasses preview side by side; keep the final cut under 3:00; hide `.env`.
