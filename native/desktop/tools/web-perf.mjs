// Idle RAM/CPU and scroll frame times of the web UI (headless Chromium on ANGLE/Vulkan) on the Albums grid.
//   node web-perf.mjs <base-url> <W> <H>   (our temp server only; refuses 4545)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../../../server/package.json'));
const { chromium } = require('playwright-core');
const [base, W, H] = process.argv.slice(2);
const u = new URL(base);
if (u.hostname !== '127.0.0.1' || u.port === '4545' || !u.port) { console.error('refusing', base); process.exit(2); }
const udd = join(process.env.HOME, 'data/agent-tmp/rune-gpui/perf-profile-' + process.pid);
const ctx = await chromium.launchPersistentContext(udd, { executablePath: '/usr/bin/chromium', headless: true,
  args: ['--headless=new', '--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu', '--password-store=basic', '--use-mock-keychain', '--mute-audio', '--disable-audio-output'], viewport: { width: +W, height: +H }, deviceScaleFactor: 1 });
const root = Number(execSync('ps -eo pid,cmd', { encoding: 'utf8' }).split('\n').find((l) => l.includes(udd) && !l.includes('--type=') && !l.includes('crashpad')).trim().split(/\s+/)[0]);
const tree = () => { const ps = execSync('ps -eo pid,ppid', { encoding: 'utf8' }).trim().split('\n').slice(1).map((l) => l.trim().split(/\s+/).map(Number)); const out = new Set([root]); let grew = true; while (grew) { grew = false; for (const [p, pp] of ps) if (out.has(pp) && !out.has(p)) { out.add(p); grew = true; } } return [...out]; };
const pssMb = () => tree().reduce((n, p) => { try { return n + Number(/Pss:\s+(\d+)/.exec(readFileSync(`/proc/${p}/smaps_rollup`, 'utf8'))?.[1] ?? 0); } catch { return n; } }, 0) / 1024;
const ticks = () => tree().reduce((n, p) => { try { const f = readFileSync(`/proc/${p}/stat`, 'utf8').split(')')[1].trim().split(/\s+/); return n + Number(f[11]) + Number(f[12]); } catch { return n; } }, 0);
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto(`${base}/albums?ambient=off`, { waitUntil: 'networkidle' });
await page.waitForTimeout(6000);
const t0 = ticks(), s0 = Date.now();
await page.waitForTimeout(10000);
const idleCpu = ((ticks() - t0) / 100) / ((Date.now() - s0) / 1000) * 100;
const idleMb = pssMb();
const res = { idle_pss_mb: +idleMb.toFixed(0), idle_cpu_pct_of_one_core: +idleCpu.toFixed(1) };
for (const [name, dy] of [['scroll_40px_per_frame', 40], ['scroll_200px_per_frame', 200]]) {
  await page.evaluate(() => document.getElementById('main').scrollTo(0, 0));
  await page.waitForTimeout(1500);
  const r = await page.evaluate(([dy]) => new Promise((resolve) => {
    const el = document.getElementById('main'); const t = []; let last = performance.now(); let n = 0;
    const step = (now) => { t.push(now - last); last = now; el.scrollTop += dy; if (++n < 300) requestAnimationFrame(step); else resolve(t.slice(1)); };
    requestAnimationFrame(step);
  }), [dy]);
  r.sort((a, b) => a - b);
  const q = (p) => r[Math.floor((r.length - 1) * p)];
  res[name] = { frames: r.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), p99: +q(0.99).toFixed(1), max: +r[r.length - 1].toFixed(1), over20ms: r.filter((x) => x > 20).length };
}
res.after_scroll_pss_mb = +pssMb().toFixed(0);
console.log(JSON.stringify(res));
await ctx.close();
