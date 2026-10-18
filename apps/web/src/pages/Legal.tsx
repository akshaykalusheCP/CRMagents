import type { ReactNode } from 'react';
import { LogoMark } from '../components/Logo';

// Public legal and trust pages: /terms, /privacy, /subprocessors, /security. Plain language, and only claims the
// product actually keeps (see docs/SECURITY.md). Have them reviewed before launch.

export type LegalDoc = 'terms' | 'privacy' | 'subprocessors' | 'security';
export const LEGAL_PATHS: Record<string, LegalDoc> = { '/terms': 'terms', '/privacy': 'privacy', '/subprocessors': 'subprocessors', '/security': 'security' };
const UPDATED = '18 October 2026';

export function PublicFooter() {
  return (
    <footer className="land-foot">
      <div className="land-inner legal-foot">
        <span>CRMagents · AI agents and analytics for Salesforce</span>
        <nav aria-label="Legal"><a href="/security">Security</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/subprocessors">Subprocessors</a><a href="/contact">Contact</a></nav>
      </div>
    </footer>
  );
}

export const SUBPROCESSORS: { name: string; purpose: string; data: string; when: string }[] = [
  { name: 'Render', purpose: 'Hosting of the application and its database', data: 'All data CRMagents stores (see the Privacy notice)', when: 'Always' },
  { name: 'Anthropic', purpose: 'AI model that agents and assistants use (default)', data: 'The text of one step at a time, with personal details masked', when: 'When the workspace uses the default AI provider' },
  { name: 'OpenAI, Google (Gemini) or another compatible provider', purpose: 'AI model, if the workspace chooses it instead', data: 'As above', when: "Only if the workspace picks it and adds its own key; that provider's terms for the workspace's account apply" },
  { name: 'Stripe', purpose: 'Payments and invoices', data: 'Billing contact, plan, payment status. Card details go to Stripe directly and never reach CRMagents', when: 'When a workspace buys a plan' },
  { name: 'Resend', purpose: 'Email from CRMagents: invitations, password resets, alerts', data: 'Recipient email address and the message', when: 'When email is sent' },
  { name: 'Twilio', purpose: 'Text and WhatsApp messages', data: 'Recipient phone number and the message', when: 'Only if the workspace turns on text messages' },
];

const DOCS: Record<LegalDoc, { title: string; lede: string; body: ReactNode }> = {
  terms: {
    title: 'Terms of service',
    lede: 'The agreement for using CRMagents. Plain language, short on purpose.',
    body: <>
      <h2>Using CRMagents</h2>
      <p>CRMagents lets your team build AI agents and assistants that work on your Salesforce data. By creating a workspace or using the service you agree to these terms on behalf of your organisation, and confirm you may do so.</p>
      <h2>Your account and team</h2>
      <p>Keep sign-in details private and give people only the role they need (owner, admin, builder or approver). You are responsible for what happens in your workspace, including what your agents are set up to do.</p>
      <h2>Your data stays yours</h2>
      <p>You own your Salesforce data and everything you create here: agents, assistants, guides and settings. You give us permission to process it only to run the service for you, as described in the <a href="/privacy">Privacy notice</a>. You can export it or delete the workspace at any time from the Trust center.</p>
      <h2>Agents act for you</h2>
      <p>Agents change records only as you configure them. Changes can need approval, are limited to the fields you allow, and are logged so they can be undone. AI can be wrong: check an agent on test runs before turning it on, and keep approvals on for changes that matter. CRMagents is not responsible for decisions made on agent output without a person's review where review was appropriate.</p>
      <h2>Acceptable use</h2>
      <p>Don't use CRMagents to break the law, send spam, harm people, attack or probe our systems or anyone else's, get around plan limits, or process data you have no right to process.</p>
      <h2>Plans, trials and payment</h2>
      <p>Basic is a 14-day free trial. When it ends, agents and website chat pause and nothing is deleted. Paid plans are billed in advance, monthly or yearly, through Stripe, and renew until cancelled. Cancelling stops the next renewal; the plan stays active until the end of the paid period. Pro Max terms are agreed in writing.</p>
      <h2>Availability and changes</h2>
      <p>We work to keep the service available and your data safe, but provide it "as is", without guarantees beyond what we agree in writing. We may improve or change features; if a change takes away something you rely on, we'll tell you in advance.</p>
      <h2>Ending</h2>
      <p>You can stop at any time by deleting the workspace. We may suspend a workspace that breaks these terms or doesn't pay, after telling you, except where we must act at once to protect others.</p>
      <h2>Liability</h2>
      <p>To the extent the law allows, neither side is liable for indirect or consequential losses, and our total liability is limited to what you paid us in the 12 months before the claim.</p>
      <h2>Changes to these terms</h2>
      <p>We'll post changes here and tell workspace owners about material ones before they take effect. Questions: <a href="/contact">contact us</a>.</p>
    </>,
  },
  privacy: {
    title: 'Privacy notice',
    lede: 'What CRMagents keeps, why, for how long, and who else is involved.',
    body: <>
      <h2>What we keep</h2>
      <ul>
        <li><b>Your account:</b> names and emails of the people in your workspace, their roles, and password hashes (never the passwords).</li>
        <li><b>Salesforce connection:</b> the org address and an access token, encrypted. Salesforce's own login page handles your Salesforce password; we never see it.</li>
        <li><b>What you build:</b> agents, assistants, rules, guides you upload, and settings. API keys you add are encrypted and can't be read back in the app.</li>
        <li><b>What happens:</b> run logs (the steps an agent took), the change log used for undo, a log of what was sent to the AI, and an activity log of sign-ins and changes.</li>
        <li><b>Memory and chats,</b> if the workspace keeps them on: saved conversations and the facts people ask assistants to remember.</li>
        <li><b>Billing:</b> plan, subscription status and invoices. Card details go to Stripe directly.</li>
        <li><b>Messages to us</b> through the contact form.</li>
      </ul>
      <h2>Your Salesforce data</h2>
      <p>CRMagents reads records only when an agent or assistant step needs them, and only the fields it names. It doesn't keep a copy of your Salesforce records. Parts of records appear in run logs and the AI log, which are cleared after the workspace's retention period (30 days unless you change it), and dashboards keep summary numbers (counts and totals) so they load quickly.</p>
      <h2>AI</h2>
      <p>Only the text of one step is sent to the AI model, after masking: emails, phone numbers, card numbers, US Social Security numbers and IBANs (plus any fields you list) are replaced by placeholders. Every AI call is recorded exactly as sent, and you can inspect it in the Trust center. We use AI providers' business APIs, under terms where they don't train their models on your data. If you bring your own key for another provider, that provider's terms for your account apply.</p>
      <h2>Why</h2>
      <p>To run the service you asked for, keep it secure, bill for it, and support you. We don't sell data, don't use it for advertising, and don't use your data to train AI models.</p>
      <h2>Who else is involved</h2>
      <p>A short list of service providers help run CRMagents; see <a href="/subprocessors">Subprocessors</a>.</p>
      <h2>How long</h2>
      <p>Run logs and the AI log: the workspace's retention period (30 days by default). Everything else: while the workspace exists. Deleting the workspace revokes CRMagents' access to your Salesforce orgs, cancels a paid subscription, and removes the workspace's data from our database. Nothing in Salesforce is deleted.</p>
      <h2>Your choices</h2>
      <p>Workspace admins can export everything as one file, change the retention period, turn memory off, add fields to mask, and delete the workspace, all from the app. People can ask us about their own data through the <a href="/contact">contact page</a>.</p>
      <h2>Cookies</h2>
      <p>One cookie keeps you signed in. No advertising or tracking cookies. The app remembers a few display choices (like the theme) in your browser.</p>
    </>,
  },
  subprocessors: {
    title: 'Subprocessors',
    lede: 'Service providers that process data so CRMagents can run. We give notice here before adding one.',
    body: <>
      <div className="legal-table">
        <table>
          <thead><tr><th>Provider</th><th>What for</th><th>What data</th><th>When</th></tr></thead>
          <tbody>{SUBPROCESSORS.map((s) => <tr key={s.name}><td><b>{s.name}</b></td><td>{s.purpose}</td><td>{s.data}</td><td>{s.when}</td></tr>)}</tbody>
        </table>
      </div>
      <p>Your Salesforce org is yours, not a subprocessor: CRMagents works in it with the access you grant and can be disconnected at any time.</p>
    </>,
  },
  security: {
    title: 'Security',
    lede: 'How CRMagents protects your org and your data. For a security review, ask us for the full notes.',
    body: <>
      <h2>Access to Salesforce</h2>
      <p>Assistants inside Salesforce act as the person asking, with their own sharing and field permissions. In the app, a workspace can require the same: each person links their own Salesforce login, and Salesforce decides what they can see and change. You connect through Salesforce's own login with the <code>api</code> and <code>refresh_token</code> scopes. Tokens are encrypted at rest (AES-256-GCM). Every call from the CRMagents package in your org is signed with a per-org secret. Disconnecting revokes access.</p>
      <h2>Agents can't go off script</h2>
      <ul>
        <li>Approvals before changes, and whoever started a run can't approve it when someone else can.</li>
        <li>Agents can only change the fields you allow. Rules you write are checked in code, not left to the AI.</li>
        <li>Per-run limits, a daily AI budget, and a monthly cap per agent. Agents that keep failing pause themselves.</li>
        <li>Every record change is logged with its old values, and one click undoes it without overwriting a person's later edit.</li>
      </ul>
      <h2>Data sent to AI</h2>
      <p>Personal details are masked before anything reaches the AI, and every AI call is recorded exactly as sent, for you to inspect.</p>
      <h2>Your team</h2>
      <p>Roles (owner, admin, builder, approver) are checked on every request. Passwords are hashed with scrypt, sign-in attempts are rate-limited, and sessions use httpOnly cookies. An activity log records every change and sign-in, with the address it came from.</p>
      <h2>Your data</h2>
      <p>Export everything as one file, or delete the workspace, at any time. See the <a href="/privacy">Privacy notice</a> and <a href="/subprocessors">Subprocessors</a>.</p>
      <h2>Reporting a problem</h2>
      <p>Found a security issue? Tell us through the <a href="/contact?topic=other">contact page</a>. We'll respond quickly and credit you if you'd like.</p>
    </>,
  },
};

export function LegalPage({ doc }: { doc: LegalDoc }) {
  const d = DOCS[doc];
  return (
    <div className="landing">
      <header className="land-nav">
        <div className="land-inner">
          <a className="land-brand" href="/" style={{ color: 'inherit', textDecoration: 'none' }}><span className="brand-mark"><LogoMark size={15} /></span>CRMagents</a>
          <nav className="land-links" aria-label="Product"><a href="/#agents">Product</a><a href="/#pricing">Pricing</a><a href="/security" aria-current={doc === 'security' ? 'page' : undefined}>Security</a><a href="/contact">Contact</a></nav>
          <div className="land-cta"><a className="land-btn ghost" href="/">Log in</a></div>
        </div>
      </header>
      <div className="land-inner legal" role="main">
        <nav className="legal-tabs" aria-label="Legal pages">
          {(['security', 'privacy', 'terms', 'subprocessors'] as LegalDoc[]).map((k) => <a key={k} href={`/${k}`} aria-current={k === doc ? 'page' : undefined}>{DOCS[k].title}</a>)}
        </nav>
        <article>
          <h1>{d.title}</h1>
          <p className="legal-lede">{d.lede}</p>
          <p className="legal-date">Last updated {UPDATED}</p>
          {d.body}
        </article>
      </div>
      <PublicFooter />
    </div>
  );
}
