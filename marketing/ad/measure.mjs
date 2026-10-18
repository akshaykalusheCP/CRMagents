// Where the things the camera and cursor go to are, in CSS pixels of the 1440x900 page (same layout as the 2x shots).
import { writeFileSync } from 'node:fs';
import { open } from './cdp.mjs';
const b = await open(process.cwd(), 1440, 900, 1);
const go = (t, w = 4500) => b.go(`http://localhost:5173/?demo&tab=${t}`, w);
const out = {};
// Smallest visible element whose text includes `text` (optionally matching a selector); its box.
const rect = (sel, text, up = 0) => b.js(`(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => e.offsetParent && (!${JSON.stringify(text)} || e.textContent.includes(${JSON.stringify(text)})));
  els.sort((a, b) => a.textContent.length - b.textContent.length);
  let e = els[0]; for (let i = 0; e && i < ${up}; i++) e = e.parentElement;
  if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})()`);
const hide = () => b.js(`(() => { const s = document.createElement('style'); s.textContent = '*::-webkit-scrollbar{display:none!important}'; document.head.appendChild(s); })()`);
await go('home'); await hide(); out.home = { suggestions: await rect('section', 'Suggested for you'), runs: await rect('.panel, section, div', 'Agent runs', 0) };
await go('discover'); await hide(); out.discover = { total: await rect('div', 'of hand work found', 1), first: await rect('li, div', 'Draft replies to customer emails', 1) };
await go('agents'); await b.click('tbody tr', 'Case triage'); await b.sleep(2500); await hide();
out.agent = { steps: await rect('.panel, section', 'What it does'), ready: await rect('div', 'Ready to run on its own', 1), title: await rect('h1, h2', 'Case triage') };
await go('agents'); await b.click('button', 'New agent'); await b.sleep(2500); await hide();
out.builder = { input: await rect('textarea', ''), question: await rect('h2, h3, div', 'What should your agent do?') };
await b.click('button', 'When a new case comes in'); await b.sleep(6000);
out.builderBuilt = { chat: await rect('div', 'Which cases, and what should start it?', 1) };
await go('approvals'); await hide(); out.approvals = { approve: await rect('button', 'Approve'), changes: await rect('div', 'Update Case 00001042', 2), card: await rect('div', 'Approve these changes?', 1) };
await go('activity'); await b.click('tbody tr', 'Case triage'); await b.sleep(2500); await hide();
out.run = { undo: await rect('button', 'Undo this run'), changes: await rect('div', 'Priority Low', 3), decision: await rect('div', 'Approved by', 0) };
await go('trust'); await hide(); out.trust = { masked: await rect('li, div', 'Personal data is masked before the AI sees it', 0), flow: await rect('div', 'Keeps your agents', 2) };
await go('insights'); await hide(); out.insights = { briefing: await rect('section, .panel, div', 'Your business briefing', 1) };
await go('impact'); await hide(); out.impact = { kpis: await rect('div', 'value for every $1 of AI', 2) };
writeFileSync('targets.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
b.close(); process.exit(0);
