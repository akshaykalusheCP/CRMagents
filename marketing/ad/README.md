# Nimbus product ad

A ~56 s product ad made from the real Nimbus screens (demo mode, agentforce demo data). Every frame is rendered
exactly by headless Chrome from `ad.html` (`render(t)` sets the whole stage for time `t`), then encoded with ffmpeg:
no screen recording, no stutter.

## Make it
1. Run the app (`npm run dev`).
2. `node capture.mjs`: screen captures at 2x into `shots/` (only when the UI changes).
3. `node measure.mjs`: where buttons and panels are (`targets.json`), so zooms and the cursor land on them.
4. `node render.mjs --stills 12,23.8,38.4`: check single frames in `stills/` (`./sheet.sh` makes a contact sheet).
5. `node render.mjs out/nimbus-ad-1080p.mp4 30 1`: 1080p; `node render.mjs out/nimbus-ad-4k.mp4 30 2`: 4K.

## Story (v2, ~90 s)
Audience: Salesforce teams that want AI agents but not per-user AI licences. Competitors aren't named; prices aren't shown.

| Time | Beat |
|---|---|
| 0–5 s | Logo builds · "AI agents for Salesforce. Without the per-user AI bill." |
| 5–10.6 s | The problem: cases pile up, leads go cold, $2.6M of pipeline stuck |
| 10.6–14.8 s | "AI agents usually mean…" per-user licences, a new data platform, consultants, months of setup: struck through |
| 14.8–20.6 s | "Nimbus connects in two minutes": the org shows Ready, Install in Salesforce |
| 20.6–33.4 s | "It lives inside Salesforce" (real Lightning, agentforce demo org): panel on the record, Ask answers, the bell, Approve on the record, Medium → High with Undo |
| 33.4–36.6 s | Sees only what each person can see in Salesforce |
| 36.6–44.4 s | "Describe the job": typing the request, the agent's steps |
| 44.4–51.6 s | Works with Flows and Apex (Automation X-ray) · proven on your own records |
| 51.6–59.2 s | "Nothing changes until you say so": approve in the app, then in Slack |
| 59.2–69.6 s | "Your data stays yours": masking to `[EMAIL_1]` · bring your own AI with a daily cap |
| 69.6–80.2 s | "And it does more than agents": briefing, dashboards, memory, Discover, the return (example workspace) |
| 80.2–90 s | "Priced for the whole team. Not per seat." · end card · Start free |

Salesforce screens: `sf-capture.mjs` with a one-time session link from `./sf-link.sh <path> <file>` (uses the Salesforce CLI's
existing login; no password). Never commit the link file.

Silent by design (most ads play muted). Add a licensed music bed or voiceover in an editor, or with ffmpeg:
`ffmpeg -i out/nimbus-ad-4k.mp4 -i music.mp3 -c:v copy -c:a aac -shortest out/with-music.mp4`.
