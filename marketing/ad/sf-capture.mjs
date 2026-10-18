// Real Salesforce screens (agentforce demo org) at 2x. Logs in through the Salesforce CLI's session link (file arg), no password.
// node sf-capture.mjs <url-file> <step,step,...>   steps run in order in one session (the link works once)
import { readFileSync } from 'node:fs';
import { open } from './cdp.mjs';
const [, , urlFile, step] = process.argv;
const b = await open(process.cwd(), 1440, 900, 2);
const click = async (x, y) => {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
};
await b.go(readFileSync(urlFile, 'utf8').trim(), 22000);
const hideScroll = () => b.js(`(() => { const s = document.createElement('style'); s.textContent = '*::-webkit-scrollbar{display:none!important}'; document.head.appendChild(s); })()`);
await hideScroll();
const shot = async (n) => { await b.sleep(600); await b.shot(`shots/${n}.png`); console.log('shot', n); };
for (const st of step.split(',')) {
  if (st === 'page') await shot('sf-case');
  if (st === 'approvals') { await click(1153, 427); await b.sleep(5000); await shot('sf-approvals'); }
  if (st === 'bell') { await click(1361, 63); await b.sleep(4000); await shot('sf-bell'); await click(1361, 63); await b.sleep(800); }
  if (st === 'ask') { await click(1086, 428); await b.sleep(3000); await shot('sf-ask-empty'); }
  if (st === 'askq') {
    await click(1086, 428); await b.sleep(2500);
    await click(1200, 560); await b.sleep(400);
    await b.send('Input.insertText', { text: 'Summarise this case and suggest the next step.' }); await b.sleep(800);
    await shot('sf-ask-typed');
    await click(1368, 612);
    await b.sleep(35000); await shot('sf-ask-answer');
  }
  if (st === 'approve') {
    await click(1162, 427); await b.sleep(4000); await shot('sf-approvals');
    await click(1342, 649); await b.sleep(15000); await shot('sf-approved');
    await b.js('location.reload()'); await b.sleep(20000); await hideScroll(); await shot('sf-after');
  }
}
console.log(b.logs.filter((l) => !/Lightning|aura|Content Security/i.test(l)).slice(0, 3).join('\n') || 'ok');
b.close(); process.exit(0);
