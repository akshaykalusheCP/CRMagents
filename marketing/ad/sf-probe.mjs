import { readFileSync } from 'node:fs';
import { open } from './cdp.mjs';
const url = readFileSync(process.argv[2], 'utf8').trim();
const b = await open(process.cwd(), 1440, 900, 1);
await b.go(url, 25000);
console.log('at', (await b.js('location.host + location.pathname')));
console.log('cards', await b.js(`[...document.querySelectorAll('*')].filter(e => e.shadowRoot).length + ' shadow hosts; nimbus text: ' + document.body.innerText.includes('Nimbus')`));
await b.shot('shots/sf-probe.png');
b.close(); process.exit(0);
