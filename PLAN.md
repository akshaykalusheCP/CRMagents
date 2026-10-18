# Nimbus: visual AI agent builder for Salesforce

Users connect their Salesforce org (OAuth), build agents in a visual builder,
install a thin managed package, and run the agents from Salesforce (record
pages, Flow, buttons). Agent logic and the LLM calls live on our platform.

## Decisions

| Area | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | One language across web, API and engine |
| API | Fastify | Fast, typed, simple |
| DB | Postgres | Tenants, workflows, runs, encrypted tokens |
| Web | Next.js + React Flow | Canvas for the builder |
| LLM | Anthropic SDK behind a provider interface | Model-agnostic later |
| SF auth | OAuth 2.0 Web Server flow + PKCE | No passwords, works with MFA and SSO |
| SF package | 2GP managed, thin (LWC, invocable Apex, Named Credential, run-log object) | Logic stays on the platform, so updates need no package upgrade |
| Async | Run ID returned immediately, Platform Event callback | Works around Apex callout limits |

## Repo layout

```
apps/api         Fastify API: OAuth, tenants, agent runs
apps/web         (Phase 2) Next.js builder UI
packages/engine  (Phase 2) workflow JSON executor + node types
salesforce/      (Phase 3) SFDX project that becomes the managed package
```

## Phases

1. **Prove the loop (current).** OAuth connect, encrypted token store, Salesforce
   tools (query, describe, get/create/update), Claude tool-use loop, run
   endpoint, minimal LWC chat.
2. **Builder MVP.** Workflow JSON schema, engine, node library (triggers, LLM
   agent, SF tools, branch, loop, human approval, HTTP, email/Slack), React
   Flow canvas with a schema-aware field picker, run logs and replay.
3. **Package v1.** Invocable actions for Flow, record-page component, permission
   sets, Platform Event callback, 2GP managed package (needs a Dev Hub).
4. **Market hardening.** Multi-tenant isolation, billing and usage metering, token
   budgets, audit log, PII masking, data retention, SSO for our app, prompt-
   injection guards, approval policies, observability.
5. **AppExchange.** Security review, listing, docs, templates gallery.

## Use-case templates (market-ready target)

Case triage and routing, case summarization and reply drafts, lead scoring and
enrichment, opportunity next-step suggestions, meeting and call note to
records, duplicate detection and merge suggestions, data quality cleanup,
email to case/lead creation, renewal risk alerts, natural-language reports
(SOQL), onboarding checklists, approval assistants.

## Security rules (non-negotiable)

- Never collect Salesforce passwords. OAuth only.
- Refresh tokens encrypted at rest (AES-256-GCM), key from env/KMS.
- Agents run as the invoking user by default (respects sharing and FLS).
- Destructive writes require approval by default.
- Record content is untrusted input to the LLM (prompt injection).
- Per-tenant token budgets and rate limits.
