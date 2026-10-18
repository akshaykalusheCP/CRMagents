import { pool } from './db.js';
import { SalesforceClient } from './salesforce/client.js';
import { getSetting, PLATFORM } from './settings.js';

// Emails from Nimbus itself (invitations, password resets, alerts). Two ways out, tried in order:
// 1. Resend, when the platform has it configured (staff console → Settings, or RESEND_API_KEY + MAIL_FROM);
// 2. the company's own connected Salesforce org (its "Send Email" action), so a workspace gets mail with no setup.
// When neither works the caller still has the link to show (an admin can copy an invite or reset link).

export interface Mail { to: string; subject: string; text: string }

const DEFAULT_FROM = 'Nimbus <noreply@crmagents.app>';

export async function mailConfig() {
  const key = await getSetting(PLATFORM, 'resendKey');
  return { key, from: (await getSetting(PLATFORM, 'mailFrom')) || DEFAULT_FROM };
}

/** Send through Resend. Returns Resend's own error text when it refuses (shown to staff on a test send). */
export async function viaResend(m: Mail): Promise<{ ok: boolean; error?: string }> {
  const { key, from } = await mailConfig();
  if (!key) return { ok: false, error: 'No Resend key set' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text }),
  });
  if (res.ok) return { ok: true };
  const body = await res.json().catch(() => ({})) as { message?: string };
  return { ok: false, error: body.message ?? `Resend answered ${res.status}` };
}

async function viaSalesforce(accountId: string, m: Mail): Promise<boolean> {
  const { rows } = await pool.query("select id from tenants where account_id=$1 and setup_status='ready' order by created_at limit 3", [accountId]);
  for (const t of rows) {
    try {
      const sf = await SalesforceClient.forTenant(t.id);
      await sf.runAction('standard', 'emailSimple', { emailAddresses: m.to, emailSubject: m.subject, emailBody: m.text });
      return true;
    } catch { /* next org */ }
  }
  return false;
}

/** Send one email for a workspace. Never throws: returns whether it went out. */
export async function sendMail(accountId: string | null, m: Mail): Promise<boolean> {
  try { if ((await viaResend(m)).ok) return true; } catch { /* fall through */ }
  if (accountId) {
    try { if (await viaSalesforce(accountId, m)) return true; } catch { /* fall through */ }
  }
  console.warn(`[mail] not sent to ${m.to}: no mail route (set up email in the staff console, or connect a Salesforce org)`);
  return false;
}
