import { pool } from '../db.js';
import { SalesforceClient, type SaveOp } from './client.js';

// Sample data for a test org: realistic accounts, contacts, leads, deals, cases and follow-ups, so agents have
// something to work on in a new trial or a sales demo. Only for sandboxes, Developer Edition and trial orgs, never
// production. Every record it creates is listed in sample_records, so "Remove" deletes exactly those and nothing else.
// Emails use reserved .example domains: an agent that emails a sample contact can't reach a real person.

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

interface Acct { key: string; Name: string; Industry: string; Type: string; Rating: string; AnnualRevenue: number; NumberOfEmployees: number; BillingCity: string; BillingCountry: string; Website: string; Phone: string }
const ACCOUNTS: Acct[] = [
  { key: 'northwind', Name: 'Northwind Logistics', Industry: 'Transportation', Type: 'Customer - Direct', Rating: 'Hot', AnnualRevenue: 48_000_000, NumberOfEmployees: 1200, BillingCity: 'Chicago', BillingCountry: 'United States', Website: 'northwind.example', Phone: '(312) 555-0141' },
  { key: 'bluepeak', Name: 'Bluepeak Health', Industry: 'Healthcare', Type: 'Customer - Direct', Rating: 'Warm', AnnualRevenue: 120_000_000, NumberOfEmployees: 3400, BillingCity: 'Boston', BillingCountry: 'United States', Website: 'bluepeak.example', Phone: '(617) 555-0188' },
  { key: 'harbor', Name: 'Harbor Foods', Industry: 'Food & Beverage', Type: 'Customer - Channel', Rating: 'Warm', AnnualRevenue: 22_000_000, NumberOfEmployees: 410, BillingCity: 'Seattle', BillingCountry: 'United States', Website: 'harborfoods.example', Phone: '(206) 555-0119' },
  { key: 'summit', Name: 'Summit Manufacturing', Industry: 'Manufacturing', Type: 'Prospect', Rating: 'Hot', AnnualRevenue: 310_000_000, NumberOfEmployees: 5200, BillingCity: 'Pune', BillingCountry: 'India', Website: 'summitmfg.example', Phone: '+91 20 5550 1290' },
  { key: 'crescent', Name: 'Crescent Energy', Industry: 'Energy', Type: 'Customer - Direct', Rating: 'Cold', AnnualRevenue: 75_000_000, NumberOfEmployees: 900, BillingCity: 'Houston', BillingCountry: 'United States', Website: 'crescentenergy.example', Phone: '(713) 555-0175' },
  { key: 'lumen', Name: 'Lumen Retail Group', Industry: 'Retail', Type: 'Prospect', Rating: 'Warm', AnnualRevenue: 64_000_000, NumberOfEmployees: 2100, BillingCity: 'London', BillingCountry: 'United Kingdom', Website: 'lumenretail.example', Phone: '+44 20 7946 0321' },
  { key: 'atlas', Name: 'Atlas Construction', Industry: 'Construction', Type: 'Customer - Direct', Rating: 'Warm', AnnualRevenue: 39_000_000, NumberOfEmployees: 650, BillingCity: 'Denver', BillingCountry: 'United States', Website: 'atlasbuild.example', Phone: '(303) 555-0102' },
  { key: 'orbit', Name: 'Orbit Telecom', Industry: 'Telecommunications', Type: 'Channel Partner / Reseller', Rating: 'Hot', AnnualRevenue: 210_000_000, NumberOfEmployees: 4100, BillingCity: 'Bengaluru', BillingCountry: 'India', Website: 'orbittel.example', Phone: '+91 80 5550 4410' },
];

const CONTACTS = [
  { key: 'maria', acct: 'northwind', FirstName: 'Maria', LastName: 'Gonzalez', Title: 'VP Operations', Email: 'maria.gonzalez@northwind.example', Phone: '(312) 555-0142' },
  { key: 'dev', acct: 'northwind', FirstName: 'Dev', LastName: 'Patel', Title: 'IT Manager', Email: 'dev.patel@northwind.example', Phone: '(312) 555-0143' },
  { key: 'sarah', acct: 'bluepeak', FirstName: 'Sarah', LastName: 'Kim', Title: 'Director of Patient Services', Email: 'sarah.kim@bluepeak.example', Phone: '(617) 555-0189' },
  { key: 'tom', acct: 'bluepeak', FirstName: 'Tom', LastName: 'Reilly', Title: 'Procurement Lead', Email: 'tom.reilly@bluepeak.example', Phone: '(617) 555-0190' },
  { key: 'ana', acct: 'harbor', FirstName: 'Ana', LastName: 'Souza', Title: 'Operations Manager', Email: 'ana.souza@harborfoods.example', Phone: '(206) 555-0120' },
  { key: 'rahul', acct: 'summit', FirstName: 'Rahul', LastName: 'Mehta', Title: 'Chief Operating Officer', Email: 'rahul.mehta@summitmfg.example', Phone: '+91 20 5550 1291' },
  { key: 'priya', acct: 'summit', FirstName: 'Priya', LastName: 'Nair', Title: 'Head of Service', Email: 'priya.nair@summitmfg.example', Phone: '+91 20 5550 1292' },
  { key: 'jake', acct: 'crescent', FirstName: 'Jake', LastName: 'Turner', Title: 'Facilities Director', Email: 'jake.turner@crescentenergy.example', Phone: '(713) 555-0176' },
  { key: 'emma', acct: 'lumen', FirstName: 'Emma', LastName: 'Clarke', Title: 'Head of Customer Experience', Email: 'emma.clarke@lumenretail.example', Phone: '+44 20 7946 0322' },
  { key: 'luis', acct: 'atlas', FirstName: 'Luis', LastName: 'Ramirez', Title: 'Project Director', Email: 'luis.ramirez@atlasbuild.example', Phone: '(303) 555-0103' },
  { key: 'karen', acct: 'atlas', FirstName: 'Karen', LastName: 'Wu', Title: 'Accounts Payable', Email: 'karen.wu@atlasbuild.example', Phone: '(303) 555-0104' },
  { key: 'arjun', acct: 'orbit', FirstName: 'Arjun', LastName: 'Rao', Title: 'Partnerships Director', Email: 'arjun.rao@orbittel.example', Phone: '+91 80 5550 4411' },
];

// Open deals at every stage: some closing soon, some overdue (close date passed, still open), a few won and lost.
const OPPS = [
  { key: 'o1', acct: 'summit', Name: 'Summit Manufacturing - Plant-wide rollout', StageName: 'Negotiation/Review', Amount: 420_000, close: 12, Probability: 80, Type: 'New Customer', NextStep: 'Legal review of the MSA' },
  { key: 'o2', acct: 'northwind', Name: 'Northwind - Fleet expansion', StageName: 'Proposal/Price Quote', Amount: 185_000, close: -9, Probability: 60, Type: 'Existing Customer - Upgrade', NextStep: 'Send revised quote' },
  { key: 'o3', acct: 'bluepeak', Name: 'Bluepeak - Patient service desk', StageName: 'Id. Decision Makers', Amount: 240_000, close: 35, Probability: 40, Type: 'Existing Customer - Upgrade', NextStep: 'Meet the CFO' },
  { key: 'o4', acct: 'orbit', Name: 'Orbit Telecom - Reseller agreement', StageName: 'Value Proposition', Amount: 310_000, close: -21, Probability: 30, Type: 'New Customer', NextStep: '' },
  { key: 'o5', acct: 'lumen', Name: 'Lumen Retail - 120 stores', StageName: 'Needs Analysis', Amount: 156_000, close: 48, Probability: 20, Type: 'New Customer', NextStep: 'Discovery call with regional managers' },
  { key: 'o6', acct: 'harbor', Name: 'Harbor Foods - Renewal', StageName: 'Proposal/Price Quote', Amount: 38_000, close: 6, Probability: 75, Type: 'Existing Customer - Replacement', NextStep: 'Confirm renewal date' },
  { key: 'o7', acct: 'atlas', Name: 'Atlas Construction - Site safety add-on', StageName: 'Qualification', Amount: 27_500, close: -40, Probability: 10, Type: 'Existing Customer - Upgrade', NextStep: '' },
  { key: 'o8', acct: 'crescent', Name: 'Crescent Energy - Downgrade request', StageName: 'Perception Analysis', Amount: 18_000, close: 20, Probability: 50, Type: 'Existing Customer - Downgrade', NextStep: 'Retention offer' },
  { key: 'o9', acct: 'summit', Name: 'Summit Manufacturing - Pilot', StageName: 'Closed Won', Amount: 45_000, close: -60, Probability: 100, Type: 'New Customer', NextStep: '' },
  { key: 'o10', acct: 'northwind', Name: 'Northwind - Annual support', StageName: 'Closed Won', Amount: 72_000, close: -95, Probability: 100, Type: 'Existing Customer - Replacement', NextStep: '' },
  { key: 'o11', acct: 'lumen', Name: 'Lumen Retail - Pilot (lost to competitor)', StageName: 'Closed Lost', Amount: 30_000, close: -70, Probability: 0, Type: 'New Customer', NextStep: '' },
  { key: 'o12', acct: 'orbit', Name: 'Orbit Telecom - Training package', StageName: 'Prospecting', Amount: 12_000, close: 75, Probability: 10, Type: 'Existing Customer - Upgrade', NextStep: '' },
];

// Open cases written like real customer messages: urgent outages, billing, how-to, a duplicate, an angry escalation
// and some noise, so triage, routing and reply agents have something meaningful to do.
const CASES = [
  { acct: 'northwind', contact: 'dev', Subject: 'URGENT: tracking portal down for all drivers', Description: 'Since 7am none of our 300 drivers can log in to the tracking portal. Deliveries are piling up and we are losing money every hour. Please call me back immediately.', Origin: 'Phone', Priority: 'Medium', Status: 'New', Type: 'Electronic', Reason: 'Breakdown' },
  { acct: 'bluepeak', contact: 'tom', Subject: 'Charged twice on invoice INV-20418', Description: 'Our card was charged twice for the October invoice (INV-20418, $12,400). Please refund the duplicate charge and confirm in writing.', Origin: 'Email', Priority: 'Medium', Status: 'New', Type: 'Other', Reason: 'Other' },
  { acct: 'harbor', contact: 'ana', Subject: 'How do I add a new warehouse user?', Description: 'We hired two new warehouse leads. What are the steps to add them and give them scanner access?', Origin: 'Web', Priority: 'Medium', Status: 'New', Type: 'Other', Reason: 'Installation' },
  { acct: 'summit', contact: 'priya', Subject: 'Line 3 sensors reporting wrong temperatures', Description: 'Since the firmware update on Monday, the temperature sensors on production line 3 read about 8 degrees high. We had to slow the line down. Need an engineer this week.', Origin: 'Email', Priority: 'Medium', Status: 'New', Type: 'Electrical', Reason: 'Performance' },
  { acct: 'crescent', contact: 'jake', Subject: 'Third time asking - nobody has replied', Description: 'This is the third time I am raising this. The generator monitoring dashboard has shown no data for 9 days. If this is not fixed by Friday we will cancel our contract.', Origin: 'Email', Priority: 'Medium', Status: 'New', Type: 'Electronic', Reason: 'Breakdown' },
  { acct: 'lumen', contact: 'emma', Subject: 'Feature request: export reports to Excel', Description: 'It would help our store managers a lot if the weekly report could be exported to Excel instead of PDF only.', Origin: 'Web', Priority: 'Medium', Status: 'New', Type: 'Other', Reason: 'Feedback' },
  { acct: 'atlas', contact: 'karen', Subject: 'Please send a copy of invoice for September', Description: 'Our auditor needs a copy of the September invoice. Could you email it to me?', Origin: 'Email', Priority: 'Medium', Status: 'New', Type: 'Other', Reason: 'Other' },
  { acct: 'orbit', contact: 'arjun', Subject: 'Partner portal login not working', Description: 'I get "invalid credentials" on the partner portal even after resetting my password twice.', Origin: 'Web', Priority: 'Medium', Status: 'New', Type: 'Electronic', Reason: 'Other' },
  { acct: 'northwind', contact: 'maria', Subject: 'Tracking portal outage - drivers cannot log in', Description: 'Following up on my colleague Dev\'s call: the tracking portal is still down for our drivers. This is now critical for us.', Origin: 'Email', Priority: 'Medium', Status: 'New', Type: 'Electronic', Reason: 'Breakdown' },
  { acct: 'bluepeak', contact: 'sarah', Subject: 'Training session for new staff', Description: 'We have 15 new patient service staff starting next month. Can we book a training session?', Origin: 'Phone', Priority: 'Medium', Status: 'New', Type: 'Other', Reason: 'Installation' },
  { acct: 'atlas', contact: 'luis', Subject: 'Hydraulic unit leaking at Denver site', Description: 'The hydraulic unit at our Denver site started leaking oil this morning. Crew has stopped work around it for safety. Need a technician.', Origin: 'Phone', Priority: 'Medium', Status: 'New', Type: 'Mechanical', Reason: 'Breakdown' },
  { acct: 'harbor', contact: 'ana', Subject: 'Shipment of replacement scanners delayed', Description: 'The 20 replacement scanners were due last Tuesday and tracking has not moved. When will they arrive?', Origin: 'Email', Priority: 'Medium', Status: 'Working', Type: 'Other', Reason: 'Other' },
  { acct: 'crescent', contact: 'jake', Subject: 'Request to reduce licence count', Description: 'We would like to go from 120 to 80 licences at renewal. What is the process?', Origin: 'Email', Priority: 'Medium', Status: 'New', Type: 'Other', Reason: 'Other' },
  { acct: null, contact: null, Subject: 'Win a free cruise!!! Click here', Description: 'Congratulations, you have been selected. Click the link to claim your prize.', Origin: 'Web', Priority: 'Medium', Status: 'New', Type: 'Other', Reason: 'Other' },
  { acct: 'summit', contact: 'rahul', Subject: 'Escalation: line 3 still not fixed', Description: 'Our COO here. Line 3 has been running at half speed for four days. I need a named engineer and a date today.', Origin: 'Phone', Priority: 'High', Status: 'Escalated', Type: 'Electrical', Reason: 'Performance' },
  { acct: 'lumen', contact: 'emma', Subject: 'Question about data retention', Description: 'For our GDPR review: how long do you keep customer data after a contract ends, and can we request deletion?', Origin: 'Email', Priority: 'Medium', Status: 'New', Type: 'Other', Reason: 'Other' },
];

// New leads from great to junk, so a scoring agent can tell them apart.
const LEADS = [
  { FirstName: 'Olivia', LastName: 'Bennett', Company: 'Pinecrest Hospitals', Title: 'Chief Operating Officer', Email: 'olivia.bennett@pinecrest.example', Phone: '(415) 555-0130', Industry: 'Healthcare', NumberOfEmployees: 6000, AnnualRevenue: 900_000_000, LeadSource: 'Web', Rating: 'Warm', Description: 'Requested a demo for 40 sites. Budget approved for this quarter; wants a proposal by month end.' },
  { FirstName: 'Hiroshi', LastName: 'Tanaka', Company: 'Kaito Robotics', Title: 'VP Engineering', Email: 'h.tanaka@kaito.example', Phone: '+81 3 5550 0199', Industry: 'Machinery', NumberOfEmployees: 1500, AnnualRevenue: 210_000_000, LeadSource: 'Partner Referral', Rating: 'Warm', Description: 'Referred by Orbit Telecom. Evaluating three vendors, decision in 6 weeks.' },
  { FirstName: 'Grace', LastName: 'Oduya', Company: 'Savanna Logistics', Title: 'Head of Operations', Email: 'grace.oduya@savanna.example', Phone: '+254 20 555 0110', Industry: 'Transportation', NumberOfEmployees: 800, AnnualRevenue: 60_000_000, LeadSource: 'Web', Rating: 'Warm', Description: 'Downloaded the fleet guide and visited pricing twice.' },
  { FirstName: 'Mark', LastName: 'Feldman', Company: 'Feldman & Sons Plumbing', Title: 'Owner', Email: 'mark@feldmanplumbing.example', Phone: '(555) 555-0123', Industry: 'Construction', NumberOfEmployees: 6, AnnualRevenue: 400_000, LeadSource: 'Web', Rating: 'Cold', Description: 'Asked if there is a free version.' },
  { FirstName: 'Test', LastName: 'Test', Company: 'asdf', Title: '', Email: 'test@test.example', Phone: '', Industry: 'Other', NumberOfEmployees: null, AnnualRevenue: null, LeadSource: 'Web', Rating: 'Cold', Description: 'asdf' },
  { FirstName: 'Chloe', LastName: 'Martin', Company: 'Verde Grocers', Title: 'IT Director', Email: 'chloe.martin@verde.example', Phone: '+33 1 5550 0144', Industry: 'Retail', NumberOfEmployees: 2300, AnnualRevenue: 140_000_000, LeadSource: 'Phone Inquiry', Rating: 'Warm', Description: 'Current contract with a competitor ends in March. Wants to compare.' },
  { FirstName: 'Samuel', LastName: 'Adeyemi', Company: 'Student', Title: 'Student', Email: 'sam.adeyemi@university.example', Phone: '', Industry: 'Education', NumberOfEmployees: null, AnnualRevenue: null, LeadSource: 'Web', Rating: 'Cold', Description: 'Writing a thesis on CRM automation, wants an interview.' },
  { FirstName: 'Fatima', LastName: 'Al-Sayed', Company: 'Gulf Petrochem', Title: 'Procurement Manager', Email: 'f.alsayed@gulfpetro.example', Phone: '+971 4 555 0177', Industry: 'Energy', NumberOfEmployees: 12000, AnnualRevenue: 4_000_000_000, LeadSource: 'Purchased List', Rating: 'Cold', Description: '' },
  { FirstName: 'Ben', LastName: 'Carter', Company: 'Carter Dental Group', Title: 'Practice Manager', Email: 'ben@carterdental.example', Phone: '(555) 555-0167', Industry: 'Healthcare', NumberOfEmployees: 45, AnnualRevenue: 5_000_000, LeadSource: 'Web', Rating: 'Cold', Description: 'Wants appointment reminders by SMS.' },
  { FirstName: 'Nina', LastName: 'Petrova', Company: 'Baltic Freight', Title: 'CEO', Email: 'nina.petrova@balticfreight.example', Phone: '+371 6 555 0102', Industry: 'Shipping', NumberOfEmployees: 350, AnnualRevenue: 48_000_000, LeadSource: 'Partner Referral', Rating: 'Warm', Description: 'Met at the logistics summit. Asked for pricing for 200 users.' },
];

// Follow-ups on open deals; several are already overdue.
const TASKS = [
  { opp: 'o2', contact: 'maria', Subject: 'Send revised quote to Maria', due: -6, Priority: 'High', Status: 'Not Started' },
  { opp: 'o4', contact: 'arjun', Subject: 'Follow up on reseller terms', due: -14, Priority: 'Normal', Status: 'Not Started' },
  { opp: 'o1', contact: 'rahul', Subject: 'Book legal review call', due: 2, Priority: 'High', Status: 'In Progress' },
  { opp: 'o6', contact: 'ana', Subject: 'Confirm renewal date with Ana', due: -1, Priority: 'Normal', Status: 'Not Started' },
  { opp: 'o3', contact: 'sarah', Subject: 'Prepare CFO meeting deck', due: 9, Priority: 'Normal', Status: 'Not Started' },
];

const ORDER = ['Account', 'Contact', 'Opportunity', 'Case', 'Lead', 'Task'] as const;

/** Is this a test org? Sandboxes, Developer Edition and trial orgs only. */
export async function sampleAllowed(sf: SalesforceClient): Promise<{ allowed: boolean; kind: string }> {
  const o = (await sf.query('SELECT OrganizationType, IsSandbox, TrialExpirationDate FROM Organization')).records[0] ?? {};
  const kind = o.IsSandbox ? 'Sandbox' : o.TrialExpirationDate ? `${o.OrganizationType} (trial)` : String(o.OrganizationType ?? 'Unknown');
  return { allowed: !!o.IsSandbox || o.OrganizationType === 'Developer Edition' || !!o.TrialExpirationDate, kind };
}

export async function sampleStatus(tenantId: string, sf?: SalesforceClient) {
  const { rows } = await pool.query('select object, count(*)::int n, min(created_at) at from sample_records where tenant_id=$1 group by object', [tenantId]);
  const counts = Object.fromEntries(rows.map((r) => [r.object, r.n])) as Record<string, number>;
  const org = sf ? await sampleAllowed(sf).catch(() => ({ allowed: false, kind: 'Unknown' })) : null;
  return { loaded: rows.length > 0, counts, loadedAt: rows.length ? rows.map((r) => r.at).sort()[0] : null, allowed: org?.allowed ?? null, orgKind: org?.kind ?? null };
}

/** Drop fields this org doesn't have, can't set, or picklist values it doesn't use, so the load works in any org. */
export function fitter(fields: Awaited<ReturnType<SalesforceClient['describe']>>) {
  const byName = new Map(fields.map((f) => [f.name, f]));
  return (rec: Record<string, unknown>) => Object.fromEntries(Object.entries(rec).filter(([k, v]) => {
    const f = byName.get(k);
    if (!f || f.createable === false || v === null || v === undefined || v === '') return false;
    if ((f.type === 'picklist') && f.picklistValues?.length) return f.picklistValues.some((p) => p.active && p.value === v);
    return true;
  }));
}

export async function loadSample(tenantId: string) {
  const sf = await SalesforceClient.forTenant(tenantId);
  const org = await sampleAllowed(sf);
  if (!org.allowed) throw Object.assign(new Error(`Sample data is only for sandboxes, Developer Edition and trial orgs. This org is ${org.kind}.`), { statusCode: 400 });
  if ((await sampleStatus(tenantId)).loaded) throw Object.assign(new Error('Sample data is already in this org. Remove it first to load it again.'), { statusCode: 409 });

  const fit = Object.fromEntries(await Promise.all(ORDER.map(async (o) => [o, fitter(await sf.describe(o))] as const))) as Record<typeof ORDER[number], (r: Record<string, unknown>) => Record<string, unknown>>;
  const ids: Record<string, string> = {};
  const failures: string[] = [];
  const save = async (object: typeof ORDER[number], items: { key?: string; fields: Record<string, unknown> }[]) => {
    const ops: SaveOp[] = items.map((i) => ({ kind: 'create', sobject: object, fields: fit[object](i.fields) }));
    const res = await sf.saveMany(ops);
    const made: string[] = [];
    res.forEach((r, i) => {
      if (r.ok && r.id) { made.push(r.id); if (items[i].key) ids[items[i].key!] = r.id; } else failures.push(`${object}: ${r.error}`);
    });
    // Recorded straight away, so a load that fails halfway can still be removed cleanly.
    if (made.length) await pool.query('insert into sample_records (tenant_id, object, record_id) select $1, $2, unnest($3::text[]) on conflict do nothing', [tenantId, object, made]);
    return made.length;
  };

  const counts: Record<string, number> = {};
  counts.Account = await save('Account', ACCOUNTS.map(({ key, ...f }) => ({ key, fields: f })));
  counts.Contact = await save('Contact', CONTACTS.map(({ key, acct, ...f }) => ({ key, fields: { ...f, AccountId: ids[acct] } })));
  counts.Opportunity = await save('Opportunity', OPPS.map(({ key, acct, close, ...f }) => ({ key, fields: { ...f, AccountId: ids[acct], CloseDate: day(close) } })));
  counts.Case = await save('Case', CASES.map(({ acct, contact, ...f }) => ({ fields: { ...f, AccountId: acct ? ids[acct] : undefined, ContactId: contact ? ids[contact] : undefined, SuppliedEmail: contact ? undefined : 'prizes@promo.example' } })));
  counts.Lead = await save('Lead', LEADS.map((f) => ({ fields: { ...f, Status: 'Open - Not Contacted' } })));
  counts.Task = await save('Task', TASKS.map(({ opp, contact, due, ...f }) => ({ fields: { ...f, WhatId: ids[opp], WhoId: ids[contact], ActivityDate: day(due) } })));
  return { counts, failures: summarize(failures) };
}

/** One line per distinct reason, with how many records it stopped (an org's validation rule rejects many at once). */
export function summarize(failures: string[]) {
  const by = new Map<string, number>();
  for (const f of failures) by.set(f, (by.get(f) ?? 0) + 1);
  return [...by].map(([f, n]) => (n > 1 ? `${n} × ${f}` : f)).slice(0, 10);
}

/** Delete exactly what the sample load created (children first). Records people already deleted are skipped. */
export async function removeSample(tenantId: string) {
  const sf = await SalesforceClient.forTenant(tenantId);
  const { rows } = await pool.query('select object, record_id from sample_records where tenant_id=$1', [tenantId]);
  let removed = 0;
  const failures: string[] = [];
  for (const object of [...ORDER].reverse()) {
    const recs = rows.filter((r) => r.object === object).map((r) => r.record_id as string);
    if (!recs.length) continue;
    const res = await sf.saveMany(recs.map((id) => ({ kind: 'delete', sobject: object, id, fields: {} })));
    const gone: string[] = [];
    res.forEach((r, i) => {
      // Already gone (deleted by a person, an agent, or with its parent account): nothing left to remove.
      if (r.ok || /ENTITY_IS_DELETED|INVALID_CROSS_REFERENCE_KEY|NOT_FOUND/i.test(r.error ?? '')) { gone.push(recs[i]); if (r.ok) removed++; } else failures.push(`${object}: ${r.error}`);
    });
    if (gone.length) await pool.query('delete from sample_records where tenant_id=$1 and record_id = any($2::text[])', [tenantId, gone]);
  }
  return { removed, failures: summarize(failures) };
}
