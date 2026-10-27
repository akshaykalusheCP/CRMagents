import { config } from '../config.js';
import { logSpend, setup } from '../insights/ai.js';
import type { SalesforceClient } from '../salesforce/client.js';

// The business profile: a page the company writes about itself (what it sells, who its customers are, the words it
// uses, its rules and tone). Every AI call gets it first, cached, so a low-cost model knows the business as well as a
// new colleague would. The first draft comes from the org itself, so nobody starts from a blank page.

/** Picklists that say what a company does and how it works, if the org has them. */
const PICKLISTS: [string, string][] = [
  ['Account', 'Industry'], ['Account', 'Type'], ['Case', 'Type'], ['Case', 'Reason'], ['Case', 'Origin'], ['Case', 'Priority'],
  ['Opportunity', 'StageName'], ['Opportunity', 'Type'], ['Lead', 'LeadSource'], ['Lead', 'Status'],
];

/** What the org says about the business: names, products and the values people pick. Counts only, no record data. */
export async function orgFacts(sf: SalesforceClient): Promise<string> {
  const lines: string[] = [];
  const q = async (soql: string) => (await sf.query(soql).catch(() => ({ records: [] as Record<string, unknown>[] }))).records as Record<string, unknown>[];
  const [org] = await q('SELECT Name, Country FROM Organization LIMIT 1');
  if (org?.Name) lines.push(`Company: ${org.Name}${org.Country ? ` (${org.Country})` : ''}`);
  const products = await q('SELECT Name FROM Product2 WHERE IsActive = true ORDER BY LastModifiedDate DESC LIMIT 30');
  if (products.length) lines.push(`Products: ${products.map((p) => p.Name).join(', ')}`);
  const industries = await q('SELECT Industry, COUNT(Id) n FROM Account WHERE Industry != null GROUP BY Industry ORDER BY COUNT(Id) DESC LIMIT 8');
  if (industries.length) lines.push(`Customer industries (most accounts first): ${industries.map((r) => `${r.Industry} (${r.n})`).join(', ')}`);
  const described = new Map<string, Awaited<ReturnType<SalesforceClient['describe']>>>();
  for (const [object, field] of PICKLISTS) {
    if (!described.has(object)) described.set(object, await sf.describe(object).catch(() => []));
    const f = described.get(object)!.find((x) => x.name === field);
    const values = (f?.picklistValues ?? []).filter((v) => v.active).map((v) => v.value).slice(0, 25);
    if (values.length) lines.push(`${object} ${f!.label}: ${values.join(' | ')}`);
  }
  return lines.join('\n');
}

const DRAFT_SYSTEM = `You write the first draft of a company's "business profile": a short page the company's AI agents read before every task.
Use only the facts given. Where a section needs knowledge you don't have, write a one-line prompt in square brackets for the team to fill in, e.g. [Who are your main customers?]. Never invent products, policies or numbers.
Sections, as short plain-text headings with a few bullet points each:
What we do / Our customers / Products and services / Words we use (what the picklist values mean here) / How we handle cases and deals / Rules and tone for agents.
Keep it under 2,500 characters.`;

export async function draftProfile(tenantId: string): Promise<string> {
  const { llm, sf } = await setup(tenantId);
  const facts = await orgFacts(sf);
  if (!facts.trim()) throw new Error('Nothing to draft from: Nimbus could not read this org yet. Write the profile yourself, or check the Salesforce connection.');
  const r = await llm.complete({ system: DRAFT_SYSTEM, prompt: `Facts from the company's Salesforce org:\n${facts}`, model: config.builderModel });
  if (!r.reused) await logSpend(tenantId, 'profile', 'Business profile draft', r.usage);
  return r.text.trim();
}
