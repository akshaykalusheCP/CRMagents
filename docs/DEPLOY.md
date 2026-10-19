# Deploying Nimbus (Render + Vercel)

```
people ──▶ Vercel (web app, nimbus-app.vercel.app)
              │  /api /oauth /public /hooks /stripe /sf  (rewrites in vercel.json)
              ▼
           Render web service (API, nimbus-api.onrender.com) ──▶ Render Postgres
              ▲
Salesforce ───┘  Apex/Flow callouts go straight to Render (BRIDGE_URL)
```

People only ever see the Vercel address, so the login cookie stays first-party and the Salesforce OAuth callback
(`PUBLIC_URL/oauth/callback`) lands on the same site as the session.

## 1. Render (API + database)
1. render.com → **New → Blueprint** → connect GitHub → pick `akshaykalusheCP/CRMagents`. It reads `render.yaml`.
2. Fill the values it asks for:

| Key | Value |
|---|---|
| `TOKEN_ENC_KEY` | Run `openssl rand -hex 32` and paste the output. **Keep a copy safe; never change it.** |
| `PUBLIC_URL`, `WEB_URL` | Your Vercel address (step 2), e.g. `https://nimbus-app.vercel.app`. Put a placeholder now and fix after step 2. |
| `BRIDGE_URL` | This service's own URL, e.g. `https://nimbus-api.onrender.com` |
| `SF_CLIENT_ID` / `SF_CLIENT_SECRET` | Nimbus Connected App → Consumer Key / Secret |
| `PLATFORM_ADMINS` | Your email (staff console) |
| `ANTHROPIC_API_KEY` | Optional platform default |
| `RESEND_API_KEY`, `MAIL_FROM` | Optional, for invite and reset emails |

3. **Apply.** The first deploy runs every database migration, then `/health` turns green.
4. If the service name was taken, Render gives a different URL: update the 7 Render addresses in `vercel.json`.

## 2. Vercel (web app)
1. vercel.com → **Add New → Project** → import the same repo.
2. Keep **Root Directory** as the repo root (`vercel.json` sets install, build and output). **Deploy.**
3. Copy the address, then in Render set `PUBLIC_URL` and `WEB_URL` to it (that redeploys the API).

## 3. Salesforce Connected App
In the org that owns the Nimbus Connected App: Setup → App Manager → Nimbus → Edit → **Callback URL**, add
`https://<vercel address>/oauth/callback` (keep the existing ones for local dev). Changes can take a few minutes.

## 4. Check
- `https://<vercel address>/health` → `{"ok":true}`
- Sign up, connect a Salesforce org, run an agent, and run a Flow that uses "Run Nimbus agent".

## Notes
- Every push to `main` deploys both (Render autoDeploy, Vercel git integration).
- An org connects to one Nimbus server at a time: connecting it to production points its package at production.
- Custom domain later: add it in Vercel, then update `PUBLIC_URL`/`WEB_URL` and the Connected App callback.
- Stripe is not set up yet (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`; webhook URL `https://<vercel address>/stripe/webhook`).
