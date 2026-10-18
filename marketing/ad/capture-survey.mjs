// First pass: every main screen in demo mode, small, to choose what the ad shows.
import { open } from './cdp.mjs';
const b = await open(process.cwd(), 1440, 900, 1);
for (const t of ['home', 'discover', 'agents', 'approvals', 'activity', 'trust', 'insights', 'dashboards', 'impact', 'memory']) {
  await b.go(`http://localhost:5173/?demo&tab=${t}`, 4000);
  await b.shot(`shots/survey-${t}.png`);
}
await b.go('http://localhost:5173/', 5000); await b.shot('shots/survey-landing.png');
console.log(b.logs.join('\n') || 'no errors'); b.close(); process.exit(0);
