# Demo script (3 minutes, simulator)

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
