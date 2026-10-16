import type { SalesforceClient } from './client.js';

// Case emails (Email-to-Case): reading the conversation for the AI, and replying in the same thread through the
// package's Apex action (Salesforce doesn't allow its Send Email action over the API).

export interface EmailLine { from: string; incoming: boolean; date: string; subject: string; text: string }

const ID = /^[a-zA-Z0-9]{15,18}$/;

/** A case Id from a case or one of its emails (agents started by a new EmailMessage get the email's Id). */
export async function caseIdFor(sf: SalesforceClient, recordId: string): Promise<{ caseId: string; emailId: string | null }> {
  if (!ID.test(recordId)) throw new Error('Bad record Id');
  if (recordId.startsWith('02s')) {
    const r = await sf.query(`SELECT ParentId FROM EmailMessage WHERE Id = '${recordId}'`);
    const parent = (r.records[0] as { ParentId?: string } | undefined)?.ParentId;
    if (!parent) throw new Error('This email is not on a case');
    return { caseId: parent, emailId: recordId };
  }
  return { caseId: recordId, emailId: null };
}

/** The new part of an email: quoted earlier messages and signatures' reply chains cut off. Pure; tested. */
export function stripQuoted(text: string): string {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const l of lines) {
    if (/^\s*On .{3,200}wrote:\s*$/.test(l) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l) || /^\s*From:\s.+@/.test(l) || /^_{5,}$/.test(l.trim())) break;
    if (/^\s*>/.test(l)) continue;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function emailThread(sf: SalesforceClient, recordId: string, max = 15) {
  const { caseId, emailId } = await caseIdFor(sf, recordId);
  const r = await sf.query(
    `SELECT Id, FromAddress, FromName, Incoming, MessageDate, Subject, TextBody FROM EmailMessage WHERE ParentId = '${caseId}' ORDER BY MessageDate DESC LIMIT ${max}`);
  const msgs = (r.records as Record<string, any>[]).reverse();
  const lines: EmailLine[] = msgs.map((m) => ({
    from: m.FromName ? `${m.FromName} <${m.FromAddress}>` : String(m.FromAddress ?? ''),
    incoming: !!m.Incoming, date: String(m.MessageDate ?? ''), subject: String(m.Subject ?? ''),
    text: stripQuoted(String(m.TextBody ?? '')).slice(0, 4000),
  }));
  const lastIn = [...msgs].reverse().find((m) => m.Incoming);
  const text = lines.length
    ? lines.map((l) => `${l.incoming ? 'Customer' : 'Us'} (${l.from}, ${l.date.slice(0, 16).replace('T', ' ')}): ${l.subject}\n${l.text}`).join('\n\n---\n\n')
    : 'No emails on this case yet.';
  return {
    caseId, text, count: lines.length,
    lastFrom: lastIn ? String(lastIn.FromAddress ?? '') : '',
    lastSubject: lastIn ? String(lastIn.Subject ?? '') : '',
    lastEmailId: emailId ?? (lastIn ? String(lastIn.Id) : ''),
  };
}

/** Plain text with **bold** and "- " bullets to simple, safe HTML for an email. Pure; tested. */
export function emailHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blocks = String(text ?? '').trim().split(/\n{2,}/);
  return blocks.map((b) => {
    const ls = b.split('\n');
    if (ls.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
      const ordered = /^\s*\d/.test(ls[0]);
      const items = ls.map((l) => `<li>${esc(l.replace(/^\s*([-*•]|\d+[.)])\s+/, '')).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</li>`).join('');
      return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
    }
    return `<p>${ls.map((l) => esc(l).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')).join('<br/>')}</p>`;
  }).join('');
}

export async function sendCaseReply(sf: SalesforceClient, o: { caseId: string; to?: string; subject?: string; body: string; inReplyToId?: string }) {
  const out = await sf.runAction('apex', 'CRMCaseEmail', {
    caseId: o.caseId, toAddress: o.to || null, subject: o.subject || null, htmlBody: emailHtml(o.body), inReplyToId: o.inReplyToId || null,
  });
  if ((out as { sent?: boolean }).sent === false) throw new Error(String((out as { error?: string }).error ?? 'The email could not be sent'));
  return out;
}
