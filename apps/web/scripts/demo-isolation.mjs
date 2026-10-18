// Proves demo mode (/?demo) never reaches the real server: walks every page and clicks the links that would leave
// the demo, recording all network traffic. Fails if any request goes to /api, /oauth or /public.
// node scripts/demo-isolation.mjs [baseUrl=http://localhost:5173] [sessionCookie]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { open } from './cdp.mjs';

const base = process.argv[2] ?? 'http://localhost:5173';
const cookie = process.argv[3];
const b = await open(mkdtempSync(`${tmpdir()}/demo-iso-`), 1440, 900, 1);
const hits = [];
await b.send('Network.enable');
b.onEvent?.('Network.requestWillBeSent', () => {});
// cdp.mjs has no event hook for this: poll performance entries instead (every request the page made).
if (cookie) await b.send('Network.setCookie', { name: 'crmagents_session', value: cookie, url: base });
const leaks = async () => (await b.js(`performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\\/(api|oauth|public)\\//.test(new URL(n).pathname))`)) ?? [];

const pages = ['home', 'discover', 'agents', 'approvals', 'activity', 'trust', 'insights', 'dashboards', 'impact', 'memory', 'knowledge', 'admin'];
const sections = ['orgs', 'ai', 'plan', 'team', 'approvals', 'rules'];
for (const t of pages) { await b.go(`${base}/?demo&tab=${t}`, 3500); hits.push(...(await leaks()).map((u) => `${t}: ${u}`)); }
for (const s of sections) { await b.go(`${base}/?demo&tab=settings&section=${s}`, 3500); hits.push(...(await leaks()).map((u) => `settings/${s}: ${u}`)); }
// The ways out: export, connect, install, Slack, checkout, link my login
const tries = [['trust', 'button', 'Export all data'], ['settings&section=orgs', 'a', 'Connect Salesforce'], ['settings&section=orgs', 'button', 'Install in Salesforce'],
  ['settings&section=approvals', 'button', 'Add to Slack'], ['settings&section=plan', 'button', 'Start with'], ['settings&section=team', 'button', 'Link my login'], ['admin', 'a', 'CSV']];
const stayed = [];
for (const [tab, sel, text] of tries) {
  await b.go(`${base}/?demo&tab=${tab}`, 3500);
  const r = await b.click(sel, text); await b.sleep(1500);
  const where = await b.js('location.pathname + location.search');
  stayed.push(`${text}: ${r === 'ok' ? 'clicked' : 'not on page'} → still at ${where}`);
  if (!String(where).includes('demo')) hits.push(`${text}: left the demo for ${where}`);
  hits.push(...(await leaks()).map((u) => `${text}: ${u}`));
}
const staff = await b.js(`document.body.innerText.includes('Staff')`);
await b.go(`${base}/?demo&tab=admin`, 3500);
const consoleShown = await b.js(`!!document.querySelector('.sc')`);
b.close();
console.log(stayed.join('\n'));
console.log(`staff console in public demo: ${consoleShown ? 'SHOWN' : 'hidden'}`);
if (hits.length || consoleShown) { console.log('FAIL\n' + [...new Set(hits)].join('\n')); process.exit(1); }
console.log(`PASS: ${pages.length + sections.length} pages and ${tries.length} ways out, no request reached the server${cookie ? ' (signed in)' : ' (anonymous)'}`);
process.exit(0);
