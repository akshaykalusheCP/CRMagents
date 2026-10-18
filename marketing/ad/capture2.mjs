// More Nimbus screens for v2 (demo mode, 2x), with a quick look at each.
import { open } from './cdp.mjs';
const b = await open(process.cwd(), 1440, 900, 2);
const go = (q, w = 4500) => b.go(`http://localhost:5173/?demo&${q}`, w);
const hide = () => b.js(`(() => { const s = document.createElement('style'); s.textContent = '*::-webkit-scrollbar{display:none!important}'; document.head.appendChild(s); })()`);
const shot = async (n) => { await hide(); await b.sleep(400); await b.shot(`shots/${n}.png`); console.log('shot', n); };
const scrollTo = (text) => b.js(`(() => { const e = [...document.querySelectorAll('h2,h3,.panel-head,.panel-title,summary')].find((x) => x.textContent.includes(${JSON.stringify(text)})); e?.scrollIntoView({ block: 'start' }); window.scrollBy(0, -90); document.querySelector('main')?.scrollBy(0, -90); return !!e; })()`);
await go('tab=settings&section=orgs'); await shot('orgs');
await go('tab=settings&section=team'); console.log('sfa', await scrollTo('Salesforce access')); await b.sleep(800); await shot('team-access');
await go('tab=settings&section=ai'); await shot('ai-settings');
await go('tab=discover'); console.log('xray', await b.click('button, a', 'Automation X-ray')); await b.sleep(3500); await shot('xray');
await go('tab=discover'); console.log('proof', await b.click('button', 'See proof')); await b.sleep(3500); await shot('proof');
await go('tab=memory'); await shot('memory');
await go('tab=dashboards'); console.log('dash', await b.js(`(() => { const e = [...document.querySelectorAll('button, a, [role=button]')].find((x) => x.textContent.includes('Sales & Service Overview')); e?.click(); return !!e; })()`)); await b.sleep(5000); await shot('dashboard');
await go('tab=agents'); console.log('assist', await b.click('button, [role=tab]', 'Assistants')); await b.sleep(2500); await shot('assistants');
console.log(b.logs.join('\n') || 'no errors'); b.close(); process.exit(0);
