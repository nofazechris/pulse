# Hosting the backend (optional)

Hosting is not required to submit. It lets someone use the packaged app without running the server on their own machine. These steps have **not been run yet**; the server was checked in production mode locally (health, CORS for a packaged app, pairing limits, demo reset blocked).

## Decide first

- Everyone who pairs shares **one demo user** and **your Binance testnet account**, and uses **your OpenAI credit**. Set a monthly spending limit in the OpenAI dashboard.
- Use a **new pairing code** (12 or more characters) just for judging, and change it afterwards.
- Free hosting plans pause a service that is idle. The first request is then slow, and **plans are not watched while it is paused**.

## Render

The repository includes [`render.yaml`](../render.yaml).

1. Push the repository to GitHub.
2. In Render, choose **New -> Blueprint** and select the repository.
3. Type the secret values when asked (never put them in the repository): `DATABASE_URL`, `BINANCE_API_KEY`, `BINANCE_API_SECRET`, `PAIRING_CODE`, `AI_API_KEY`. `SESSION_SECRET` is generated for you.
4. When it is live, open `https://<your-service>.onrender.com/api/v1/health`. It should report `ok`, `connected` and `available`.

The blueprint uses the Frankfurt region because Binance may refuse some server locations (not verified here). If your Neon database is in a US region, each query is slower from Europe.

Database migrations are not run by the host. Run `npm run db:migrate` from your machine when the schema changes.

## Build the app for the hosted server

```powershell
npm run pack:ehpk -- --api https://<your-service>.onrender.com
```

This bakes the address into the app, whitelists it in the manifest, checks the built files for every secret in `apps/api/.env`, and writes `pulse.ehpk`. Whoever installs it enters the pairing code in the app's panel.

## Security notes

- `CORS_ORIGIN=*` is used because the packaged app's origin is not documented. Authentication is a bearer token; there are no cookies.
- Rate limits: 240 requests a minute, 10 pairing attempts a minute, 60 agent messages a minute, per caller.
- Do not run the test suite against the database a hosted server is watching.
