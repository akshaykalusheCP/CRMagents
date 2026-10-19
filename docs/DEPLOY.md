# Deploying Nimbus (Render + Vercel)

```
people ──▶ Vercel (web app, nimbus-app.vercel.app)
              │  /api /oauth /public /hooks /stripe /sf  (rewrites in vercel.json)
              ▼
           Render web service (API, nimbus-api-h5sj.onrender.com) ──▶ Neon Postgres (Ohio)
              ▲
Salesforce ───┘  Apex/Flow callouts go straight to Render (BRIDGE_URL)
```

People only ever see the Vercel address, so the login cookie stays first-party and the Salesforce OAuth callback
(`PUBLIC_URL/oauth/callback`) lands on the same site as the session.

## 0. Neon (database)
1. neon.tech → sign up → **New project**: name `nimbus`, Postgres 16, region **AWS US East 2 (Ohio)** (the API runs in Render's Ohio region next to it).
2. **Connect** → turn **Connection pooling OFF** → copy the connection string (no `-pooler` in the host; drop `&channel_binding=require`).
   It is `DATABASE_URL` below. The background worker uses session-level Postgres locks, which a transaction pooler breaks.

## 1. Render (API)
1. render.com → **New → Blueprint** → connect GitHub → pick `akshaykalusheCP/CRMagents`. It reads `render.yaml`.
2. Fill the values it asks for:

| Key | Value |
|---|---|
| `DATABASE_URL` | The Neon connection string from step 0 |
| `TOKEN_ENC_KEY` | Run `openssl rand -hex 32` and paste the output. **Keep a copy safe; never change it.** |
| `PUBLIC_URL`, `WEB_URL` | Your Vercel address (step 2), e.g. `https://nimbus-app.vercel.app`. Put a placeholder now and fix after step 2. |
| `BRIDGE_URL` | This service's own URL, e.g. `https://nimbus-api-h5sj.onrender.com` |
| `SF_CLIENT_ID` / `SF_CLIENT_SECRET` | Nimbus Connected App → Consumer Key / Secret |
| `PLATFORM_ADMINS` | Your email (staff console) |
| `ANTHROPIC_API_KEY` | Optional platform default |
| `RESEND_API_KEY`, `MAIL_FROM` | Optional, for invite and reset emails |

3. **Apply.** The first deploy runs every database migration, then `/health` turns green.
4. If the service name was taken, Render gives a different URL: update the Render addresses in `apps/web/vercel.json`.

## 2. Vercel (web app)
1. vercel.com → **Add New → Project** → import the same repo.
2. On the "web" app click **Import single project** (Root Directory `apps/web`; `apps/web/vercel.json` sets install, build and rewrites). **Deploy.**
3. Copy the address, then in Render set `PUBLIC_URL` and `WEB_URL` to it (that redeploys the API).

## 3. Salesforce Connected App
In the org that owns the Nimbus Connected App: Setup → App Manager → Nimbus → Edit → **Callback URL**, add
`https://<vercel address>/oauth/callback` (keep the existing ones for local dev). Changes can take a few minutes.

## 4. Check
- `https://<vercel address>/health` → `{"ok":true}`
- Sign up, connect a Salesforce org, run an agent, and run a Flow that uses "Run Nimbus agent".

## Free-plan limits (trial)
- Render free sleeps after 15 min without traffic: schedules, record watchers and wait steps pause until someone
  opens the app (first request takes ~50 s). Upgrade nimbus-api to Starter before real customers.
- While the API is awake, its worker touches the database every minute, so Neon's compute stays on. Watch Neon →
  Usage; the free plan's monthly compute hours run out if it is kept awake around the clock.
- Without `RESEND_API_KEY` + `MAIL_FROM`, "Forgot password" and invite emails are not sent (admins can still copy
  invite and reset links from the Team page).

## Notes
- Every push to `main` deploys both (Render autoDeploy, Vercel git integration).
- An org connects to one Nimbus server at a time: connecting it to production points its package at production.
- Custom domain later: add it in Vercel, then update `PUBLIC_URL`/`WEB_URL` and the Connected App callback.
- Stripe is not set up yet (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`; webhook URL `https://<vercel address>/stripe/webhook`).
