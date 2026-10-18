# Nimbus ad: edit script (v2, 1:30)

**Audience:** Salesforce teams that want AI agents but not per-user AI licences.
**Message:** AI agents for Salesforce, priced for the whole team, with safety built in.
**Rules:** no competitor named on screen, no prices shown. "Example workspace" whenever demo numbers appear as results.

## Specs
| | |
|---|---|
| Master | 3840×2160 (4K) and 1920×1080, 30 fps, H.264 High, BT.709 |
| Audio | 48 kHz stereo, mix at −14 LUFS integrated, true peak ≤ −1 dBTP (social); −23 LUFS for broadcast |
| Font | Inter: headlines 750 weight, tight tracking (−0.04 em); captions 600 |
| Colours | Navy stage `#0a1628` · violet `#7a5cff` · blurple `#533afd` · coral `#ff7a45` · gradient words violet→pink→peach |
| Safe area | Captions in a dark glass pill, bottom centre (top centre when the camera works at the bottom of a screen) |

## Assets
| File | What |
|---|---|
| `out/nimbus-ad-v2-sound-1080p.mp4` | Full cut with sound (reference) |
| `out/nimbus-ad-v2-1080p.mp4` | Picture only |
| `audio/sfx.wav` | Sound effects stem, synced to the picture |
| `audio/bed.wav` | Music bed stem (pads Am–F–C–G, soft pulse while product is on screen) |
| `audio/mix.wav` | Both stems mixed (before loudness normalisation) |
| `audio/cues.csv` | Every sound cue: time, sound, what it's for (175 cues) |
| `shots/*.png` | Every screen at 2880×1800 (real Nimbus and real Salesforce) for re-cuts |
| `../../brand/` | Logo files (SVG/PNG, light and dark) |

To change timing, edit `ad.html` (picture) and `audio/sfx.py` (sound) together, then re-render:
`node render.mjs out/x.mp4 30 2` and `python3 audio/sfx.py`.

## Beat by beat
VO lines are optional: the cut works silent with captions. If you add voice-over, duck the bed −6 dB under it.

| # | Timecode | Picture | On-screen text | Camera / motion | Sound | Optional VO |
|---|---|---|---|---|---|---|
| 1 | 0:00–0:05 | Logo builds on the navy stage: tile, cloud, node drops in, wordmark | "Nimbus" · "AI agents for Salesforce." · *"Without the per-user AI bill."* | Tile scales up from blur; letters rise; zoom-through exit | Whoosh in · **boom** on the cloud · pop on the node · key ticks on letters · shimmer on tagline · whoosh-through out | "Nimbus. AI agents for Salesforce." |
| 2 | 0:05–0:10.6 | Kinetic headlines | "Cases pile up." · "Leads go cold." · **$2.6M** *of pipeline, stuck past its close date.* | Words rise from blur, leave with blur | Swish per line · counter ticks speeding up · pop when it lands | "Cases pile up. Leads go cold. Deals slip." |
| 3 | 0:10.6–0:14.8 | Four glass cards | "AI agents usually mean…" Per-user licences · A new data platform · Consultants · Months of setup | Cards rise in 3D one by one; a coral line strikes each through | Card pops · **zip** per strike · riser into the answer | "AI agents usually mean licences for every seat, a new data platform, and months of setup." |
| 4 | 0:14.8–0:20.6 | Headline, then Nimbus › Settings › Salesforce orgs | "Nimbus connects *in two minutes.*" · cap: "Log in with Salesforce. Nimbus sets itself up." | Window flies in tilted; push in on the org (Ready); cursor clicks Install in Salesforce; toast | Whoosh-through · window whoosh · air on push-in · **click** · **chime** | "Nimbus connects in two minutes. Log in with Salesforce; it sets itself up." |
| 5 | 0:20.6–0:33.4 | Headline, then **real Salesforce** (Lightning Case page) | "It lives *inside Salesforce.*" · caps: "Agents and an assistant on every record." · "Ask about any record, in plain English." · "Approvals arrive in the Salesforce bell." · "Approve it right on the record." · "Every change is logged, with one-click undo." | One window, five screens joined by zoom-through blur: panel → assistant answer → bell → approve (cursor click) → Medium → High with Undo (ring) | Swish per cut · blip on the answer · **ding** on the bell · **click** + **chime** on Approve · pop on the highlight | "It lives inside Salesforce. Ask about any record. Approve right on the record. And undo any change." |
| 6 | 0:33.4–0:36.6 | Nimbus › Team › Salesforce access | cap: "It sees only what each person can see in Salesforce." | Push in on the panel | Window whoosh · air | "And it only sees what each person can see." |
| 7 | 0:36.6–0:44.4 | Headline, then the builder, then the agent | "Describe the job." *Nimbus builds the agent.* · caps: "Say it in plain English." (top) · "A working agent, step by step." | Push in on the request box; cursor clicks; text types; zoom-through to the agent; push in on its steps | Swish · click · **typing** (52 keys) · whoosh-through · air | "Describe the job in plain English, and get a working agent." |
| 8 | 0:44.4–0:51.6 | Automation X-ray, then Discover proof | caps: "Works with your Flows and Apex. X-ray spots conflicts first." · "Proven on your own records before it goes live." | Push in on "2 automations set Case.Priority"; cut; push in on 8 of 8 · 88% agree | Window whoosh · air · swish · pop on 88% | "It works with your Flows and Apex, and it's proven on your own records before it goes live." |
| 9 | 0:51.6–0:59.2 | Headline, then Approvals, then a Slack card | "Nothing changes *until you say so.*" · caps: "Every change waits for a person." · "Or approve right in Slack." | Spotlight on the changes; cursor clicks Approve (turns green, toast); window steps back as the Slack card slides in; cursor approves in Slack | Swish · **click** + **chime** · slide whoosh · **click** + **chime** | "Nothing changes until you say so, in Nimbus, in Salesforce, or in Slack." |
| 10 | 0:59.2–1:09.6 | Headline, then Trust center, then AI settings | "Your data *stays yours.*" · caps: "Personal data is masked before the AI sees it." · "Bring your own AI: Claude, OpenAI or Gemini. With a daily cap." | Push in on the masking safeguard; ring; an email address scrambles into `[EMAIL_1]`; cut to provider and daily budget | Swish · pop · blip · **glitch** during the scramble · pop when it settles · swish | "Your data stays yours: personal details are masked, and you choose the AI and the budget." |
| 11 | 1:09.6–1:20.2 | Headline, then a 5-screen montage | "And it does *more than agents.*" · caps: briefing · dashboards · memory · Discover · "And shows the return. (Example workspace.)" | Windows enter from alternating sides with a 3D turn; quick push-ins | Swish · side whoosh per screen (panned left/right) | "Briefings, dashboards, memory: and proof of the return." |
| 12 | 1:20.2–1:30 | Headline, then end card | "Priced for the *whole team.*" *Not per seat. No per-user AI licences.* · Logo · pills: Approval before every change · One-click undo · No per-user AI licences · **Start free** · 14-day free trial · connect in minutes | Logo rebuilds and lifts; pills and button rise; button glow pulses; fade to black from 1:28.6 | Whoosh-through · riser · **boom** · pop · key ticks · shimmer · pill pops · button pop + shimmer | "Priced for the whole team. Start free." |

## Sound design notes
- All effects are synthesised in `audio/sfx.py` (no samples, no licences): clicks (tick + noise + low thock), keys (randomised), pops (pitch drops), whooshes (swept band-pass noise, panned), boom (sub sweep + reverb), chime (two bell notes a fifth apart), ding (inharmonic bell), zip (rising noise), glitch (crushed square blips), ticks, risers.
- Rhythm: one whoosh per window in/out, one swish per headline or cut; clicks land on the frame the cursor presses; chimes land 0.15–0.25 s after the click (on the green state or toast).
- The bed drops its pulse under every full-screen headline so the line breathes, and lifts for the end card.
- Want a real composed track? Replace `bed.wav` with a licensed track at ~100 BPM; keep effects at the same level and sidechain the music −3 dB under clicks and chimes.

## Cut-downs
- **30 s:** beats 1 (shortened to 3 s), 3, 4, 5 (panel → approve → undo only), 9 (app approve only), 12.
- **15 s:** logo 2 s → beat 5 approve + undo 7 s → end card 6 s with "Without the per-user AI bill."
- **9:16 vertical:** same beats; stack headline above a portrait crop of each screen (the camera targets in `targets.json` give the crop centres); captions at the top third.

## Before publishing
- Replace or approve showing real names in the Salesforce screens (Case Owner "Akshay Kalushe") and the org's app name ("INSURENET ONE"); re-shoot with a demo user if needed.
- Check the trademark of "Nimbus" before paid placement.
- Keep competitor names and prices off screen (decided).
