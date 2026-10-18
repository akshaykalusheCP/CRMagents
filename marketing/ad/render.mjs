// Renders ad.html frame by frame (exact time per frame, no screen recording) and encodes with ffmpeg.
// node render.mjs <out.mp4> [fps=30] [scale=1 (1080p) | 2 (4K)] [from=0] [to=DURATION] | node render.mjs --stills t1,t2,...
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { open } from './cdp.mjs';
const here = process.cwd();
const html = readFileSync('ad.html', 'utf8').replace('__TARGETS__', readFileSync('targets.json', 'utf8'));
writeFileSync('ad.final.html', html);
const stills = process.argv[2] === '--stills';
const [out, fps = 30, scale = 1, from = 0, to] = stills ? [] : process.argv.slice(2).map((v, i) => (i ? Number(v) : v));
const b = await open(here, 1920, 1080, stills ? 1 : scale);
await b.go('file://' + here + '/ad.final.html', 3000);
await b.js('document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode().catch(() => 0))))');
const frame = async (t) => {
  await b.js(`render(${t}); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  const r = await b.send('Page.captureScreenshot', { format: 'jpeg', quality: 93, optimizeForSpeed: true });
  return Buffer.from(r.data, 'base64');
};
if (stills) {
  mkdirSync('stills', { recursive: true });
  for (const t of process.argv[3].split(',').map(Number)) writeFileSync(`stills/t${t.toFixed(1).padStart(5, "0")}.jpg`, await frame(t));
  console.log(b.logs.join('\n') || 'stills ok'); b.close(); process.exit(0);
}
const dur = to ?? Number(await b.js('window.DURATION'));
const dir = `frames-${scale}x`; rmSync(dir, { recursive: true, force: true }); mkdirSync(dir);
const n = Math.round((dur - from) * fps); const t0 = Date.now();
for (let i = 0; i < n; i++) {
  writeFileSync(`${dir}/f${String(i).padStart(5, '0')}.jpg`, await frame(from + i / fps));
  if (i % 150 === 0) console.log(`frame ${i}/${n} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
console.log(b.logs.join('\n') || 'frames ok'); b.close();
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(fps), '-i', `${dir}/f%05d.jpg`,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', scale > 1 ? '14' : '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart', out], { stdio: 'inherit' });
console.log('wrote', out);
process.exit(0);
