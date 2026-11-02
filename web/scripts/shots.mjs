// Screenshot harness: builds nothing, serves dist via `vite preview` in mock mode, drives real Chromium with GPU (ANGLE/Vulkan).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'shots');
mkdirSync(out, { recursive: true });
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;

const preview = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const stop = () => { try { preview.kill('SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stop);

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE); if (r.ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('preview did not start');
}

const ARGS = ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'];
// usage: node scripts/shots.mjs [all|glass|perf]   (default all = original set + glass + perf)
const MODE = process.argv[2] ?? 'all';
const want = (m) => MODE === 'all' || MODE === m;
const shot = async (page, name, opts = {}) => {
  await page.waitForTimeout(opts.wait ?? 450);
  await page.screenshot({ path: join(out, name + '.png'), ...opts.shot });
  console.log('shot', name);
};
const scrollMain = (page, sel, extra = -70) =>
  page.evaluate(([s, e]) => { const m = document.querySelector('#main'); const t = document.querySelector(s); if (m && t) m.scrollTop = t.getBoundingClientRect().top - m.getBoundingClientRect().top + m.scrollTop + e; }, [sel, extra]);

let browser, browserGL;
try {
  await waitUp();
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ARGS });

  if (MODE === 'all') {
  // ---------- desktop ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
    await page.goto(`${BASE}/?mock=1`);
    await page.waitForSelector('.card__title');
    await page.waitForTimeout(600);
    await shot(page, 'desktop-home');
    const gpu = await page.evaluate(() => { const c = document.createElement('canvas'); const gl = c.getContext('webgl'); const e = gl?.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; });
    console.log('GPU renderer:', gpu);

    await page.click('.side a[href="/albums"]');
    await page.waitForSelector('.vgrid .card__title');
    await shot(page, 'desktop-albums');

    await page.locator('.card__title', { hasText: /^Glass Harbour$/ }).first().click();
    await page.waitForSelector('.quote');
    await shot(page, 'desktop-album-top', { wait: 700 });
    await scrollMain(page, '#review');
    await shot(page, 'desktop-album-reception');
    await scrollMain(page, '#about');
    await shot(page, 'desktop-album-about');
    await scrollMain(page, '#credits');
    await shot(page, 'desktop-album-credits');
    await page.evaluate(() => { const m = document.querySelector('#main'); m.scrollTop = m.scrollHeight; });
    await shot(page, 'desktop-album-bottom');

    // multi-disc
    await page.goto(`${BASE}/albums`);
    await page.locator('.card__title', { hasText: /^Long Division$/ }).first().click();
    await page.waitForSelector('.tracks__disc');
    await page.evaluate(() => { document.querySelector('#main').scrollTop = 300; });
    await shot(page, 'desktop-album-multidisc');

    // artist
    await page.goto(`${BASE}/albums`);
    await page.locator('.card__title', { hasText: /^Glass Harbour$/ }).first().click();
    await page.waitForSelector('.ahero__meta');
    await page.locator('.ahero__meta a', { hasText: 'Aster Vale' }).click();
    await page.waitForSelector('.arthero__name');
    await shot(page, 'desktop-artist', { wait: 700 });

    // search
    await page.fill('.topbar input', 'glass');
    await page.waitForSelector('.topres');
    await shot(page, 'desktop-search', { wait: 800 });

    // now playing
    await page.goto(`${BASE}/`);
    await page.waitForSelector('.npbar__art');
    await page.click('.npbar__art');
    await page.waitForSelector('.np__title');
    await shot(page, 'desktop-nowplaying', { wait: 900 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // queue drawer
    await page.click('button[aria-label="Queue"]');
    await shot(page, 'desktop-queue', { wait: 500 });
    await page.click('button[aria-label="Queue"]');

    // signal path popover
    await page.click('button[aria-label^="Signal path"]');
    await shot(page, 'desktop-signal-popover', { wait: 250 });
    await page.keyboard.press('Escape');
    await page.click('button[aria-label="Choose playback zone"]');
    await shot(page, 'desktop-zone-popover', { wait: 250 });
    await page.keyboard.press('Escape');

    // fix match
    await page.goto(`${BASE}/albums`);
    await page.locator('.card__title', { hasText: /^Unlabelled Rip/ }).first().click();
    await page.waitForSelector('.banner');
    await page.click('.banner__btn');
    await page.waitForSelector('.cand');
    await page.click('.cand >> nth=0');
    await shot(page, 'desktop-fixmatch-dialog', { wait: 400 });
    await ctx.close();
  }

  // ---------- mobile ----------
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('MOBILE PAGEERROR', e.message));
    await page.goto(`${BASE}/?mock=1`);
    await page.waitForSelector('.card__title');
    await page.waitForSelector('.mini');
    await shot(page, 'mobile-home', { wait: 700 });
    const hs = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    console.log('mobile home horizontal overflow:', hs);

    await page.goto(`${BASE}/albums`);
    await page.waitForSelector('.vgrid .card__title');
    await shot(page, 'mobile-albums');

    await page.locator('.card__title', { hasText: /^Glass Harbour$/ }).first().click();
    await page.waitForSelector('.quote');
    await shot(page, 'mobile-album', { wait: 700 });
    await page.evaluate(() => { const m = document.querySelector('#main'); m.scrollTop = 520; });
    await shot(page, 'mobile-album-tracks');
    await scrollMain(page, '#review');
    await shot(page, 'mobile-album-reception');
    await scrollMain(page, '#credits');
    await shot(page, 'mobile-album-credits');
    console.log('mobile album horizontal overflow:', await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1 || document.querySelector('#main').scrollWidth > document.querySelector('#main').clientWidth + 1));

    await page.click('.mini__main');
    await page.waitForSelector('.np__title');
    await shot(page, 'mobile-nowplaying', { wait: 900 });
    await page.evaluate(() => { document.querySelector('.np__body').scrollTop = 600; });
    await shot(page, 'mobile-nowplaying-scrolled');
    await page.click('button[aria-label="Close Now Playing"]');
    await page.waitForTimeout(200);
    await page.click('.tabs button');
    await shot(page, 'mobile-queue', { wait: 500 });
    await page.click('.tabs a[href="/search"]');
    await page.fill('.search--page input', 'ast');
    await page.waitForSelector('.topres');
    await shot(page, 'mobile-search', { wait: 800 });
    await ctx.close();
  }
  }

  // ---------- v1.1 glass + ambient: every phase, mock mode ----------
  if (want('glass')) {
    browserGL = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ARGS.map((a) => (a === '--use-angle=vulkan' ? '--use-angle=gl' : a)).filter((a) => a !== '--enable-features=Vulkan') });
    const gp = await browserGL.newPage();
    console.log('GL browser renderer:', await gp.evaluate(() => { const c = document.createElement('canvas'); const gl = c.getContext('webgl'); const e = gl?.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; }));
    await gp.close();
    const MOBILE = {
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    };
    for (const phase of ['blue', 'purple', 'slate', 'green']) {
      const force = (ctx) => ctx.addInitScript((p) => { try { localStorage.setItem('rune.ambient', p); } catch { /* ignore */ } }, phase);
      // desktop
      {
        const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
        await force(ctx);
        const page = await ctx.newPage();
        page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
        await page.goto(`${BASE}/?mock=1`);
        await page.waitForSelector('.card__title');
        await shot(page, `glass-desktop-home-${phase}`, { wait: 800 });
        await page.click('.side a[href="/albums"]');
        await page.waitForSelector('.vgrid .card__title');
        await page.evaluate(() => { document.querySelector('#main').scrollTop = 420; });
        await shot(page, `glass-desktop-albums-${phase}`, { wait: 700 });
        await page.locator('.card__title', { hasText: /^Glass Harbour$/ }).first().click();
        await page.waitForSelector('.quote');
        await shot(page, `glass-desktop-album-${phase}`, { wait: 900 });
        await page.evaluate(() => { document.querySelector('#main').scrollTop = 620; });
        await shot(page, `glass-desktop-album-scrolled-${phase}`, { wait: 600 });
        if (phase === 'purple') {
          await page.click('button[aria-label="Settings"]');
          await shot(page, 'glass-desktop-settings-menu', { wait: 300 });
        }
        await ctx.close();
      }
      // mobile
      {
        // This Chromium + ANGLE/Vulkan build drops backdrop-filter at devicePixelRatio >= 2 (reproduced with a bare <div>),
        // so the 3x mobile captures use ANGLE/GL (still the NVIDIA GPU, never SwiftShader).
        const ctx = await browserGL.newContext(MOBILE);
        await force(ctx);
        const page = await ctx.newPage();
        page.on('pageerror', (e) => console.log('MOBILE PAGEERROR', e.message));
        await page.goto(`${BASE}/?mock=1`);
        await page.waitForSelector('.card__title');
        await page.waitForSelector('.mini');
        await shot(page, `glass-mobile-home-${phase}`, { wait: 900 });
        await page.locator('.card__title', { hasText: /^Glass Harbour$/ }).first().click();
        await page.waitForSelector('.quote');
        await shot(page, `glass-mobile-album-${phase}`, { wait: 900 });
        await page.evaluate(() => { document.querySelector('#main').scrollTop = 520; });
        await shot(page, `glass-mobile-album-scrolled-${phase}`, { wait: 600 });
        await ctx.close();
      }
    }
  }

  // ---------- animation cost: cycle running (forced into a crossfade) while scrolling the albums grid ----------
  if (want('perf')) {
    const sample = async (label, ambient, vp, extra = {}) => {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, ...extra });
      await ctx.addInitScript((a) => { try { localStorage.setItem('rune.ambient', a); } catch { /* ignore */ } }, ambient);
      const page = await ctx.newPage();
      await page.goto(`${BASE}/albums?mock=1`);
      await page.waitForSelector('.vgrid .card__title');
      await page.waitForTimeout(500);
      const r = await page.evaluate(async () => {
        // park the cycle in the middle of the blue->purple fade and keep it there for the whole run (it still animates 12 s)
        for (const a of document.getAnimations()) if (/amb-/.test(a.animationName ?? '')) a.currentTime = 20000;
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
        return { frames: dts.length, avg, p95: sorted[Math.floor(sorted.length * 0.95)], worst: sorted[sorted.length - 1], over20: dts.filter((d) => d > 20).length, over33: dts.filter((d) => d > 33.4).length, anims: document.getAnimations().length };
      });
      console.log(`PERF ${label}: frames=${r.frames} avg=${r.avg.toFixed(2)}ms p95=${r.p95.toFixed(1)}ms worst=${r.worst.toFixed(1)}ms >20ms=${r.over20} >33ms=${r.over33} runningAnimations=${r.anims}`);
      await ctx.close();
    };
    const D = { width: 1600, height: 1000 };
    const M = { width: 390, height: 844 };
    await sample('desktop cycle (mid-fade)', 'cycle', D);
    await sample('desktop static purple (baseline)', 'purple', D);
    await sample('desktop ambient off (baseline)', 'off', D);
    await sample('mobile 390x844 cycle (mid-fade)', 'cycle', M, { isMobile: true, hasTouch: true });
    await sample('mobile static purple (baseline)', 'purple', M, { isMobile: true, hasTouch: true });
  }
} finally {
  await browserGL?.close();
  await browser?.close();
  stop();
}
