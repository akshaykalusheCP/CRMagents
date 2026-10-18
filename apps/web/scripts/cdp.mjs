// Tiny headless-Chrome driver for screenshots: import { open } and script steps.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export async function open(outDir, w = 1440, h = 900, dsf = 1) {
  const dir = mkdtempSync(join(outDir, 'chrome-'));
  const port = 9400 + Math.floor(Math.random() * 400);
  const chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${port}`, `--window-size=${w},${h}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let target; for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {} }
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map(); const logs = [];
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') logs.push('exception: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('error: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300)); });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dsf, mobile: w < 600 });
  const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;
  return {
    sleep, js, logs, send,
    go: async (url, wait = 2500) => { await send('Page.navigate', { url }); await sleep(wait); },
    click: (sel, text) => js(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})]; const el = ${text ? `els.find((e) => e.textContent.trim().includes(${JSON.stringify(text)}))` : 'els[0]'}; if (!el) return 'missing ' + ${JSON.stringify(sel + ' ' + (text ?? ''))}; el.click(); return 'ok'; })()`),
    shot: async (file) => { await sleep(400); const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(outDir, file), Buffer.from(r.data, 'base64')); },
    close: () => { chrome.kill(); },
  };
}
