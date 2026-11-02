// Screenshots + frame-time sampling for the Dither ambient. Serves dist via `vite preview` (mock mode), real Chromium with GPU.
// usage: node scripts/dither-shots.mjs [all|shots|frames|perf]
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'shots');
mkdirSync(out, { recursive: true });
const PORT = Number(process.env.PORT ?? 4191);
const BASE = `http://127.0.0.1:${PORT}`;
const preview = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const stop = () => { try { preview.kill('SIGTERM'); } catch { /* gone */ } };
process.on('exit', stop);
async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE); if (r.ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('preview did not start');
}
const ARGS = ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'];
const MODE = process.argv[2] ?? 'all';
const want = (m) => MODE === 'all' || MODE === m;
const T = process.env.DT ?? '23';
const D = { width: 1600, height: 1000 };
const M = { width: 390, height: 844 };

let browser;
try {
  await waitUp();
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ARGS });
  const open = async (path, ambient, vp = D, extra = {}) => {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, ...extra });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('CONSOLE', m.text()); });
    const sep = path.includes('?') ? '&' : '?';
    await page.goto(`${BASE}${path}${sep}mock=1&ambient=${ambient}&dither-t=${T}`);
    if (ambient.startsWith('dither')) await page.waitForSelector('.ambient__dither');
    return { ctx, page };
  };
  const snap = async (page, name, opts = {}) => { await page.waitForTimeout(opts.wait ?? 700); await page.screenshot({ path: join(out, `dither-${name}.png`), ...opts }); console.log('shot', name); };

  if (want('frames')) {
    // backdrop alone at several moments (UI hidden) to judge composition/motion
    for (const t of [0, 15, 30, 45, 60]) {
      const ctx = await browser.newContext({ viewport: D });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/?mock=1&ambient=dither&dither-t=${t}`);
      await page.waitForSelector('.ambient__dither');
      await page.addStyleTag({ content: '#root > :not(.ambient) { visibility: hidden !important; }' });
      await snap(page, `bg-t${t}`, { wait: 300 });
      await ctx.close();
    }
  }

  if (want('shots')) {
    {
      const { ctx, page } = await open('/', 'dither');
      await page.waitForSelector('.card__title');
      const gpu = await page.evaluate(() => { const c = document.createElement('canvas'); const gl = c.getContext('webgl'); const e = gl?.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; });
      console.log('GPU renderer:', gpu);
      console.log('canvas', await page.evaluate(() => { const c = document.querySelector('.ambient__dither'); return `${c.width}x${c.height} css ${c.style.width} ${c.style.height}`; }));
      await snap(page, 'red-home');
      await page.click('.side a[href="/albums"]');
      await page.waitForSelector('.vgrid .card__title');
      await snap(page, 'red-albums');
      await page.locator('.card__title', { hasText: /^Glass Harbour$/ }).first().click();
      await page.waitForSelector('.quote');
      await snap(page, 'red-album', { wait: 900 });
      // backdrop only, for contrast measurement
      await page.goto(`${BASE}/?mock=1&ambient=dither&dither-t=${T}`);
      await page.waitForSelector('.card__title');
      await page.addStyleTag({ content: '#root > :not(.ambient) { visibility: hidden !important; }' });
      await snap(page, 'red-bgonly', { wait: 300 });
      await ctx.close();
    }
    for (const c of ['blue', 'green', 'purple', 'cycle']) {
      const { ctx, page } = await open('/', `dither-${c}`);
      await page.waitForSelector('.card__title');
      await snap(page, `${c}-home`);
      await ctx.close();
    }
    {
      const { ctx, page } = await open('/', 'dither', M, { isMobile: true, hasTouch: true });
      await page.waitForSelector('.card__title');
      await snap(page, 'red-mobile-home');
      await ctx.close();
    }
    {
      // 4x grain crop: same CSS region re-rendered at devicePixelRatio 4 (each dither dot = 2 CSS px = 8 device px)
      const { ctx, page } = await open('/', 'dither', D, { deviceScaleFactor: 4 });
      await page.waitForSelector('.card__title');
      await snap(page, 'grain-4x', { clip: { x: 1180, y: 120, width: 300, height: 190 } });
      await ctx.close();
    }
    {
      // reduced motion: static frame, no rAF loop
      const { ctx, page } = await open('/', 'dither', D, { reducedMotion: 'reduce' });
      await page.waitForSelector('.card__title');
      await snap(page, 'red-reduced-motion');
      await ctx.close();
    }
  }

  if (MODE === 'contrast') {
    // text rects + backdrop-only captures at several moments; analysed by a separate script (WCAG on the mean backdrop luminance)
    const { writeFileSync } = await import('node:fs');
    const res = [];
    for (const [route, vp, tag] of [['/', D, 'home'], ['/albums', D, 'albums'], ['/', M, 'mobile']]) {
      for (const t of [0, 12, 23, 34, 45, 56, 67, 80]) {
        const ctx = await browser.newContext({ viewport: vp, ...(vp === M ? { isMobile: true, hasTouch: true } : {}) });
        const page = await ctx.newPage();
        await page.goto(`${BASE}${route}?mock=1&ambient=${process.env.AMB ?? 'dither'}&dither-t=${t}`);
        await page.waitForSelector('.card__title');
        await page.waitForTimeout(300);
        const texts = await page.evaluate(() => {
          const out = [];
          const walker = document.createTreeWalker(document.querySelector('#root'), NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent.trim()) continue;
            const el = n.parentElement;
            if (el.closest('.side, .npbar, .tabs, .mini, .cover, .pop__panel, button.btn--primary, .ambient')) continue;
            const r = document.createRange(); r.selectNodeContents(n);
            const b = r.getBoundingClientRect();
            if (b.width < 2 || b.bottom < 0 || b.top > innerHeight || b.right < 0 || b.left > innerWidth) continue;
            const cs = getComputedStyle(el);
            out.push({ text: n.textContent.trim().slice(0, 30), x: b.left, y: b.top, w: b.width, h: b.height, color: cs.color, size: parseFloat(cs.fontSize), weight: cs.fontWeight, cls: el.className });
          }
          return out;
        });
        await page.addStyleTag({ content: '#root > :not(.ambient) { visibility: hidden !important; }' });
        await page.waitForTimeout(200);
        const file = join(out, `contrast-${tag}-t${t}.png`);
        // freeze: the canvas keeps animating, so the bg is a few hundred ms later than the text rects — fine at this speed
        await page.screenshot({ path: file });
        res.push({ tag, t, file, texts });
        await ctx.close();
      }
    }
    writeFileSync(join(out, 'contrast.json'), JSON.stringify(res));
    console.log('contrast data written');
  }

  if (want('perf')) {
    const sample = async (label, ambient, vp, extra = {}, throttle = 1) => {
      const { ctx, page } = await open('/albums', ambient, vp, extra);
      await page.waitForSelector('.vgrid .card__title');
      if (throttle > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle }); }
      await page.waitForTimeout(800);
      const r = await page.evaluate(async () => {
        const m = document.querySelector('#main');
        const dts = []; let last = performance.now(); const t0 = last; let y = 0, dir = 1;
        await new Promise((res) => {
          const tick = (now) => {
            dts.push(now - last); last = now;
            y += dir * 14; if (y > m.scrollHeight - m.clientHeight - 5 || y < 0) dir = -dir;
            m.scrollTop = y;
            if (now - t0 < 5000) requestAnimationFrame(tick); else res();
          };
          requestAnimationFrame(tick);
        });
        dts.shift();
        const sorted = [...dts].sort((a, b) => a - b);
        const avg = dts.reduce((a, b) => a + b, 0) / dts.length;
        return { frames: dts.length, avg, p95: sorted[Math.floor(sorted.length * 0.95)], worst: sorted[sorted.length - 1], over20: dts.filter((d) => d > 20).length, over33: dts.filter((d) => d > 33.4).length };
      });
      console.log(`PERF ${label}: frames=${r.frames} avg=${r.avg.toFixed(2)}ms p95=${r.p95.toFixed(1)}ms worst=${r.worst.toFixed(1)}ms >20ms=${r.over20} >33ms=${r.over33}`);
      await ctx.close();
    };
    await sample('desktop dither red', 'dither', D);
    await sample('desktop dither cycle', 'dither-cycle', D);
    await sample('desktop cycle (baseline)', 'cycle', D);
    await sample('desktop off (baseline)', 'off', D);
    await sample('desktop dither red @2x DPR', 'dither', D, { deviceScaleFactor: 2 });
    await sample('mobile dither red', 'dither', M, { isMobile: true, hasTouch: true });
    await sample('desktop dither red, CPU throttled 4x', 'dither', D, {}, 4);
    await sample('desktop cycle, CPU throttled 4x (baseline)', 'cycle', D, {}, 4);
    // mode switch cleans up: canvas removed and its GL context released
    {
      const { ctx, page } = await open('/', 'dither', D);
      await page.waitForSelector('.card__title');
      const r = await page.evaluate(async () => {
        const c = document.querySelector('.ambient__dither');
        const gl = c.getContext('webgl');
        localStorage.setItem('rune.ambient', 'blue');
        return { before: !!c, lostBefore: gl.isContextLost() };
      });
      await page.click('button[aria-label="Settings"]');
      await page.locator('.menu__item', { hasText: /^Blue$/ }).click();
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => ({ canvases: document.querySelectorAll('.ambient__dither').length, layers: document.querySelectorAll('.ambient__l').length, attr: document.documentElement.dataset.ambient }));
      console.log('SWITCH dither -> blue:', JSON.stringify({ ...r, ...after }));
      await ctx.close();
    }
  }
} finally {
  await browser?.close();
  stop();
}
