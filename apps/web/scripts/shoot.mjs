// UI check: screenshots of the running app via headless Chrome (Chrome DevTools Protocol, no dependencies).
// node scripts/shoot.mjs <url> <width> <height> <out.png> [js-step out.png]...   DARK=1 emulates a dark OS.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, w, h, ...rest] = process.argv.slice(2);
const profile = mkdtempSync(join(process.env.SHOT_TMP ?? tmpdir(), 'shot-'));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn('google-chrome', ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--window-size=${w},${h}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: 1, mobile: +w < 500 });
if (process.env.DARK) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await send('Page.navigate', { url }); await sleep(3500);
const shot = async (out) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(out, Buffer.from(r.data, 'base64')); console.log('saved', out); };
await shot(rest[0]);
for (let i = 1; i + 1 < rest.length; i += 2) {
  const r = await send('Runtime.evaluate', { expression: rest[i], awaitPromise: true });
  if (r.exceptionDetails) console.log('step error', r.exceptionDetails.text);
  await sleep(1500); await shot(rest[i + 1]);
}
ws.close(); chrome.kill(); await sleep(300);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
