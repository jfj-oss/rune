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

const ARGS = ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu'];
const shot = async (page, name, opts = {}) => {
  await page.waitForTimeout(opts.wait ?? 450);
  await page.screenshot({ path: join(out, name + '.png'), ...opts.shot });
  console.log('shot', name);
};
const scrollMain = (page, sel, extra = -70) =>
  page.evaluate(([s, e]) => { const m = document.querySelector('#main'); const t = document.querySelector(s); if (m && t) m.scrollTop = t.getBoundingClientRect().top - m.getBoundingClientRect().top + m.scrollTop + e; }, [sel, extra]);

let browser;
try {
  await waitUp();
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ARGS });

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
} finally {
  await browser?.close();
  stop();
}
