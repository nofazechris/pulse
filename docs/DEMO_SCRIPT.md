# Demo script (about 2-3 minutes, simulator)

## Easiest way: the demo autopilot (you only press record and talk)

The app can perform the whole demo by itself through the real controller (real Binance Testnet data, the real approval flow, ONE small approved testnet order). It also shows a **teleprompter** (what to say, what to point at) in the app window.

```powershell
npm run dev          # terminal 1: API on :8787 + glasses dev server on :5173
npm run demo         # terminal 2: opens the Even Hub simulator and starts the autopilot after a 5 s countdown
```

1. Wait until `npm run demo` has opened the simulator (two windows: the glasses and the app panel). The autopilot waits until the app is paired and on Home, then shows "Recording starts in 5...".
2. Start your screen recorder when you see the countdown (Windows: **Win+G** -> Capture; or OBS). Capture both simulator windows side by side.
3. Read the narration box aloud as it changes. It finishes in about 2 minutes (3 at worst on a slow connection). `npm run demo:fast` is a tighter cut. **Stop demo** aborts it.
4. You can also start it from the app panel ("Demo autopilot" -> Run demo) or open `http://localhost:5173/?autorun=1&countdown=5` in a browser (in-memory glasses preview instead of the simulator).

What it does, in order: home -> start session -> biggest holding -> Bitcoin performance -> "why is it moving" (facts vs UNVERIFIED) -> add SOL to watchlist -> prepare a $50 BTC buy -> swipe to APPROVE -> tap -> Binance-confirmed result with order id -> last order status -> remember a preference -> end session -> new session that remembers it -> safety close.

Each run starts clean (it resets the demo watchlist and closes pending proposals; exchange order history is never deleted) and places exactly one testnet order. The script lives in `apps/glasses/src/demo/script.ts`; edit the wording/timing there.

If voice matters to you: with `STT_PROVIDER`/`STT_API_KEY` set you can instead double-tap and speak the same lines yourself; the autopilot types them for you so the video is reliable.

## Recording it silently with ffmpeg (how demo-video/pulse-demo.mp4 was made)

`scripts/record-demo.mjs` records ONLY the two simulator windows' screen rectangles (not your desktop) and joins them side by side. Windows can only be recorded correctly while they are on top, so pin them first (otherwise whatever covers them, e.g. a chat window, is recorded). Steps used:

1. `npm run dev`, then start the simulator on a long countdown: `npx evenhub-simulator "http://localhost:5173/?autorun=1&countdown=20"`.
2. Put the two simulator windows on top and read their rectangles (the window titles are "Glasses Display" and "Browser"; DPI-aware pixel coordinates; crop ~8 px of invisible border).
3. `node scripts/record-demo.mjs capture --panel x,y,w,h --glasses x,y,w,h --seconds 200`
4. Find where the first step starts (the panel switches from "Recording starts in N..." to "DEMO 1/15"), then `node scripts/record-demo.mjs compose --trim <seconds> --length <seconds>`.

Output: `demo-video/pulse-demo.mp4` (git-ignored; silent; the on-screen caption box is the teleprompter for a voice-over added later, e.g. in Clipchamp).

## Manual script

**Setup (once):** `apps/api/.env` filled (Neon, Binance testnet key, `SESSION_SECRET`, `PAIRING_CODE`); `apps/glasses/.env.development.local` has `VITE_DEMO_PAIRING_CODE` for auto-pair.

```powershell
npm run dev          # API :8787 + Vite :5173
npm run simulator    # Even Hub simulator (second terminal)
```

Speak the lines (or type them in the companion panel's "Talk to PULSE" box / click the chips; the glasses view is mirrored in the panel). Gestures: double-tap = talk, swipe = move, tap = select, hold = back/cancel.

| Time | Say / do | What the judge sees | Why it matters |
|---|---|---|---|
| 0:00 | Launch. | Connection screen -> Home: greeting, **portfolio value in USDT, 24h change, BTC/ETH prices**, header says TESTNET | Glanceable, real data |
| 0:15 | "Pulse, start my trading session." | Greeting built from verified data (and "Welcome back..." on later runs) | Session + memory |
| 0:25 | "What's my biggest holding?" | Portfolio screen: biggest asset and total over priced assets, "N unpriced excluded" | Real read; honest about junk testnet assets |
| 0:40 | "How is Bitcoin performing?" | Market screen: price, 24h %, high/low, age | Verified fact with freshness |
| 0:55 | "Why is Bitcoin moving today?" | `FACT:` lines + `UNVERIFIED: I cannot verify why it moved: no news or event data source is connected.` | No fabricated causes |
| 1:10 | "Add SOL to my watchlist" | Watchlist with live prices/arrows | Write to Neon |
| 1:20 | "Prepare a $50 BTC buy." | **Trade proposal**: TESTNET banner, BUY BTC (BTCUSDT), 50 USDT, MARKET ~price, est. fee, `> REJECT <` preselected | Exact terms, safe default |
| 1:40 | Swipe down (selection moves to `> APPROVE <`), tap | "THINKING..." then **ORDER RESULT: CONFIRMED**, `Bought ... BTC at avg ...`, `BINANCE ORDER #<id>` | Approved write, exchange-confirmed |
| 2:00 | (optional) Tap approve again / say "approve" with nothing pending | Nothing happens: no duplicate order, "nothing waiting for approval" | Safety |
| 2:10 | "What happened to my last order?" | Status read back from Binance | Read after write |
| 2:25 | "Remember that I focus on BTC and ETH." then "End my session." | Saved; session summary | Persistent memory |
| 2:40 | Start a new session | Greeting: "Welcome back... I remember: focus on btc and eth... Last session: ..." | Memory across sessions |
| 2:50 | Show the panel Diagnostics | DB, Binance testnet, AI/STT provider status, request ids | Reliability |

**Backup beats (if time):** hold during the proposal = cancel (nothing sent); a proposal left alone expires (countdown in footer); "price of dogecoin" -> honest "not listed".

**If something fails live:** `npm run db:check`; panel Diagnostics shows which service is down; `DEMO_MODE=true` gives a clearly labelled DEMO dataset (never switched on silently).

**Recording notes:** capture the simulator window and the panel's glasses preview side by side; keep the final cut under 3:00; hide `.env`.
