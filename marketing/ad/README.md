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

## Story
| Time | Beat |
|---|---|
| 0–5 s | Logo builds: tile, cloud, the node drops in, wordmark |
| 5–11 s | The problem: cases pile up, leads go cold, $2.6M of pipeline stuck |
| 11–19.5 s | "Describe the job": typing the request, the agent appears step by step |
| 19.5–26.5 s | "Nothing changes until you say so": approve in the app, then in Slack |
| 26.5–33.5 s | "Changed your mind?": the change log and one-click undo |
| 33.5–40 s | "Your data stays yours": an email masked to `[EMAIL_1]` |
| 40–48 s | Montage: the briefing, hand work found, the return |
| 48–56 s | End card: logo, three promises, Start free |

Silent by design (most ads play muted). Add a licensed music bed or voiceover in an editor, or with ffmpeg:
`ffmpeg -i out/nimbus-ad-4k.mp4 -i music.mp3 -c:v copy -c:a aac -shortest out/with-music.mp4`.
