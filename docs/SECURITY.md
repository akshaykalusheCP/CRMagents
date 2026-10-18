# Nimbus security notes

For answering a client's security questionnaire. The Trust center in the app (account menu → Trust center)
shows the same controls with each workspace's live settings, and prints as a report.

## Data flow
- **Salesforce → Nimbus:** OAuth with scopes `api refresh_token`. Records are read when an agent step needs
  them (only the fields it names). Discover and the Automation X-ray read counts and metadata only.
- **Nimbus → AI provider:** only the text of one step, after masking. Emails, phone numbers, card numbers,
  SSNs and IBANs (plus any fields the workspace lists) are replaced by placeholders such as `[EMAIL_1]` and put
  back only in what is written to Salesforce. Every AI call is recorded exactly as sent (Trust center → What the AI saw).
- **Stored by Nimbus:** agent definitions, run logs (cleared after the retention period, default 30 days),
  the change log used for undo, AI call log (same retention), activity log, uploaded guides.

## Controls
| Area | Control |
| --- | --- |
| Secrets | Salesforce refresh tokens and API keys encrypted at rest with AES-256-GCM; write-only in the UI |
| Passwords | scrypt hashes; 10 characters minimum; sign-in throttled per email and address (shared across servers) |
| Sessions | random 256-bit tokens, stored hashed, httpOnly + SameSite=Lax cookies, Secure on HTTPS; signed out on password reset |
| Access | roles owner / admin / builder / approver, checked on every API request; tenant ownership checked on every org route |
| Salesforce sharing | inside Salesforce, assistants run their tools in Apex as the person asking (user mode). In the app, a workspace can make assistants, dashboards and questions act as each person through their own linked Salesforce login (same org only, token encrypted, revoked on unlink), so Salesforce enforces their sharing, FLS and object permissions; results are never cached across people, and org-wide Insights are admin-only. Background agents use the org connection, like any integration user |
| Separation of duties | whoever started a run can't approve it when someone else can |
| Salesforce ↔ Nimbus | every call from the package is HMAC-SHA256 signed with a per-org secret and a timestamp (replay window) |
| Agent safety | approvals before changes, field limits, rules checked in code, per-run limits, daily budget, monthly cap per agent |
| Changes | every record change logged with its old values; one-click undo that never overwrites a person's later edit |
| Webhooks | Twilio requests verified with Twilio's signature; Slack button clicks with Slack's signing secret (5-minute window), counted only for a workspace member whose Slack email matches; agent webhooks with a per-agent secret |
| Website chat | origin allow-list, per-visitor and per-assistant rate limits, email one-time codes before showing personal data |
| Requests | JSON-only API (form posts accepted only on the Twilio webhook); security headers (nosniff, frame deny, referrer policy, HSTS on HTTPS); no-store on API responses |
| Outbound calls | HTTP steps go through a guarded fetch that blocks private and internal addresses |
| Audit | activity log of every change, sign-in and failed sign-in, with address; export of everything (incl. memory and chats) and workspace deletion (cancels a paid subscription, revokes Salesforce access) |

## Accepted risks
- `mammoth` (reads .docx guides) depends on `argparse` → `sprintf-js`, which has a moderate denial-of-service
  advisory. It is only reachable from mammoth's command-line tool, which Nimbus never runs; no fixed version exists yet.

## Still to do
- Hosting with HTTPS everywhere (planned on Render), backups and region choice.
- Independent penetration test; SOC 2 is a later step.
- Two-factor sign-in.
