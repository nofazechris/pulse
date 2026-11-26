# Submission sheet

Deadline: **Sunday Nov 29, 2026, 23:59 Dubai** = **20:59 UTC+1** (the page's own timer). Page: <https://dorahacks.io/hackathon/even-realities/detail> -> **Submit Build**.

## Checklist

| Item | Required | Status |
|---|---|---|
| Public GitHub / GitLab / Bitbucket repository with a setup README | Yes | README ready; repository to be created and pushed |
| Demo video, up to 3 minutes, simulator or G2 | Yes | `demo-video/pulse-demo.mp4` (2:56); upload and paste the link |
| Short description: problem, who it is for, how it works, track | Yes | Below |
| Feature requests (up to 5) | Optional | Below |
| Packaged `.ehpk` | Optional | Built: `pulse.ehpk` in the project folder; rebuild with `npm run pack:ehpk` |
| "How did you hear about this hackathon?" | Form field | Name the community that sent you, if one did |

`.ehpk` note: no hosted server is needed. Opened without one, the app offers a **practice mode** (double-tap on the first screen) with sample data and simulated orders, labelled DEMO. Real Binance Testnet data needs the server from the repository.

## Fields to paste

**Name**

PULSE

**Tagline**

Your financial world, at a glance.

**Track**

03 Exchanges & Stocks (Binance)

**Short description**

> **Problem.** Checking a position or acting on a price move means pulling out a phone, and "trading by voice" is dangerous without hard guardrails.
>
> **Who it is for.** Active traders who want a glance, a short phrase and one confirming tap.
>
> **How it works.** PULSE shows one thing at a time on G2. Ask about your portfolio or a price; buy, sell half, or set a trade plan ("if Bitcoin drops 2 percent, buy 20 dollars") by voice. The server watches plans and puts the prepared order on the lens when you are looking. A spoken trade is only a proposal: the backend validates it, binds it to the exact terms shown, and sends it to Binance only after you swipe to approve and tap. Open orders can be cancelled the same way. An AI explains verified data and labels what it cannot verify; it can never approve, execute or cancel.
>
> **Track.** 03 Exchanges & Stocks, running on Binance Spot Testnet right now.
>
> **Try it.** Install the attached package (or run the repository without any keys) and double-tap the first screen for practice mode: sample prices and simulated orders, clearly labelled. The video shows the real testnet mode.

**Feature requests (optional)**

1. Even Hub: a way for an app that is not in the foreground to raise a glanceable alert, so a price plan can reach the wearer when it triggers.
2. Even Hub SDK: document the values of the audio source and status in `audioEvent`, so apps can handle them without guessing.
3. Even Hub simulator: deliver clicks consistently as `textEvent` or `sysEvent` (apps currently handle both).
4. Binance Spot Testnet: a way to reset an account to a small, clean set of balances (the default holds hundreds of test assets).

## Steps

1. Create an empty **public** repository and push this project (no `.env` files are tracked).
2. Upload the video (YouTube, public or unlisted) and open the link in a private window to check it plays.
3. On the hackathon page choose **Submit Build**, paste the fields, add both links, attach `pulse.ehpk` if wanted.
4. Reopen the submission and check every link.
