// Screenshots + phone overflow sweep for the L bug reports (playlist hero on the phone, pins, Spotify removal, volume
// hint). Serves the built dist with `vite preview` in mock mode and drives headless Chromium on the GPU (ANGLE), never
// SwiftShader. No real server, no Spotify.
//
//   node scripts/shots-l-bugs.mjs <outDir> [prefix]
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? join(root, 'shots');
const prefix = process.argv[3] ?? '';
mkdirSync(out, { recursive: true });
const PORT = 4199;
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

const COMMON = ['--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio', '--password-store=basic', '--use-mock-keychain'];
const VULKAN = ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', ...COMMON];
// backdrop-filter drops out at DPR >= 2 on the Vulkan path of this build; GL is still the GPU (see shots.mjs).
const GL = ['--use-gl=angle', '--use-angle=gl', ...COMMON];
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const phone = (width, height = 932) => ({ viewport: { width, height }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });

const shot = async (page, name, opts = {}) => {
  await page.waitForTimeout(opts.wait ?? 500);
  await page.screenshot({ path: join(out, `${prefix}${name}.png`), ...(opts.shot ?? {}) });
  console.log('shot', name);
};

/** Elements that stick out of the viewport without a horizontally scrolling ancestor. */
const overflowReport = (page) => page.evaluate(() => {
  const W = window.innerWidth;
  const main = document.querySelector('#main');
  // an ancestor excuses the overhang when it really scrolls, or when it is a clipped box well inside the screen
  // (an ellipsised title); a screen-wide overflow:hidden box is the bug itself, not an excuse
  const scrolls = (el) => { const o = getComputedStyle(el).overflowX; const r = el.getBoundingClientRect(); return ((o === 'auto' || o === 'scroll') && el.scrollWidth > el.clientWidth) || ((o === 'hidden' || o === 'clip') && r.width < W - 2); };
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right <= W + 1 && r.left >= -1) continue;
    if (getComputedStyle(el).position === 'fixed' || el.closest('[aria-hidden="true"]')) continue;
    let p = el.parentElement; let clipped = false;
    while (p && p !== document.body) { if (scrolls(p) && p.getBoundingClientRect().right <= W + 1 && p.getBoundingClientRect().left >= -1) { clipped = true; break; } p = p.parentElement; }
    if (clipped) continue;
    const cls = typeof el.className === 'string' ? el.className.split(' ').slice(0, 2).join('.') : '';
    bad.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} [${Math.round(r.left)}..${Math.round(r.right)}]`);
    if (bad.length >= 6) break;
  }
  return { docScroll: document.documentElement.scrollWidth > W + 1, mainScroll: main ? main.scrollWidth > main.clientWidth + 1 : null, bad };
});

const GRENADE = async (ctx) => {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  return page;
};

const liked = `${BASE}/playlist/${encodeURIComponent('pl:sp:liked')}`;
let browser, browserGL;
const sweep = {};
try {
  await waitUp();
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: VULKAN });
  browserGL = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: GL });
  {
    const p = await browser.newPage();
    console.log('GPU renderer:', await p.evaluate(() => { const c = document.createElement('canvas'); const gl = c.getContext('webgl'); const e = gl?.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; }));
    await p.close();
  }

  // ---------- phone 430x932 @3x ----------
  {
    const ctx = await browserGL.newContext(phone(430));
    const page = await GRENADE(ctx);
    await page.goto(`${BASE}/?mock=1`);
    await page.waitForSelector('.card__title');
    await page.goto(liked);
    await page.waitForSelector('.ahero__actions');
    await shot(page, 'phone-liked-hero', { wait: 900 });
    // the track menu on a Liked Songs row
    await page.locator('button[aria-label^="More for"]').first().click();
    await shot(page, 'phone-liked-trackmenu', { wait: 400 });
    await page.keyboard.press('Escape');
    // an owned Spotify playlist
    await page.goto(`${BASE}/playlists`);
    await page.locator('.card__title', { hasText: /^HORSE$/ }).first().click();
    await page.waitForSelector('.ahero__actions');
    await shot(page, 'phone-spotify-playlist-hero', { wait: 800 });
    // an album page
    await page.goto(`${BASE}/albums`);
    await page.waitForSelector('.vgrid .card__title');
    await page.locator('.card__title').first().click();
    await page.waitForSelector('.ahero__actions');
    await shot(page, 'phone-album-hero', { wait: 800 });
    // pin it from the … menu (after-build only: the item exists then)
    await page.click('.ahero__actions button[aria-label="More actions"]');
    await shot(page, 'phone-album-menu', { wait: 300 });
    const pin = page.locator('.menu__item', { hasText: /^Pin/ });
    if (await pin.count()) { await pin.first().click(); await page.waitForTimeout(400); await shot(page, 'phone-album-pinned', { wait: 300 }); }
    else await page.keyboard.press('Escape');
    await page.goBack(); // in-app: the mock's pins live in the page
    await page.waitForSelector('.vgrid .card__title');
    await shot(page, 'phone-albums', { wait: 900 });
    // Now Playing on the iPhone Connect zone
    await page.goto(`${BASE}/`);
    await page.waitForSelector('.mini');
    await page.click('.mini__main');
    await page.waitForSelector('.np__title');
    await page.click('button[aria-label="Choose playback zone"]');
    await page.waitForTimeout(300);
    await page.locator('.menu__item--zone', { hasText: 'iPhone' }).first().click();
    await page.waitForTimeout(500);
    await shot(page, 'phone-nowplaying-iphone-zone', { wait: 700 });
    await ctx.close();
  }

  // ---------- phone overflow sweep at 390 and 430 ----------
  for (const width of [390, 430]) {
    const ctx = await browserGL.newContext(phone(width, 844));
    const page = await GRENADE(ctx);
    await page.goto(`${BASE}/?mock=1`);
    await page.waitForSelector('.card__title');
    const routes = ['/', '/albums', '/artists', '/people', '/tracks', '/genres', '/radio', '/playlists', '/discover', '/stats', '/settings', '/search', '/duplicates', `/playlist/${encodeURIComponent('pl:sp:liked')}`];
    for (const r of routes) {
      await page.goto(`${BASE}${r}`);
      await page.waitForTimeout(900);
      sweep[`${width}:${r}`] = await overflowReport(page);
    }
    // album, artist, owned + foreign Spotify playlist, rune playlist
    await page.goto(`${BASE}/albums`); await page.waitForSelector('.vgrid .card__title'); await page.locator('.card__title').first().click(); await page.waitForSelector('.ahero__actions'); await page.waitForTimeout(700);
    sweep[`${width}:album`] = await overflowReport(page);
    await page.locator('.ahero__meta a').first().click(); await page.waitForTimeout(900);
    sweep[`${width}:artist`] = await overflowReport(page);
    for (const name of ['HORSE', 'Sunday Folk', 'Focus: Deep Time']) {
      await page.goto(`${BASE}/playlists`); await page.waitForSelector('.card__title');
      await page.locator('.card__title', { hasText: name }).first().click(); await page.waitForSelector('.ahero__actions'); await page.waitForTimeout(700);
      sweep[`${width}:playlist ${name}`] = await overflowReport(page);
      if (name === 'Focus: Deep Time') await shot(page, `phone${width}-foreign-playlist-hero`, { wait: 200 });
    }
    await ctx.close();
  }

  // ---------- desktop ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const page = await GRENADE(ctx);
    await page.goto(`${BASE}/?mock=1`);
    await page.waitForSelector('.card__title');
    await page.goto(liked);
    await page.waitForSelector('.ahero__actions');
    await page.evaluate(() => { const m = document.querySelector('#main'); m.scrollTop = 180; });
    await page.locator('button[aria-label^="More for"]').first().click();
    await shot(page, 'desktop-liked-trackmenu', { wait: 500 });
    const rm = page.locator('.menu__item', { hasText: /Remove from Liked Songs/ });
    if (await rm.count()) {
      await rm.first().click();
      await shot(page, 'desktop-liked-confirm', { wait: 400 });
      const confirm = page.locator('.dialog button', { hasText: /^Remove/ });
      if (await confirm.count()) { await confirm.first().click(); await shot(page, 'desktop-liked-removed', { wait: 900 }); }
      else await page.keyboard.press('Escape');
    } else await page.keyboard.press('Escape');
    // an owned Spotify playlist: hero chips + the menu
    await page.goto(`${BASE}/playlists`);
    await page.locator('.card__title', { hasText: /^HORSE$/ }).first().click();
    await page.waitForSelector('.ahero__actions');
    await page.locator('button[aria-label^="More for"]').first().click();
    await shot(page, 'desktop-owned-playlist-trackmenu', { wait: 500 });
    await page.keyboard.press('Escape');
    // a playlist the account cannot edit
    await page.goto(`${BASE}/playlists`);
    await page.locator('.card__title', { hasText: /^Focus: Deep Time$/ }).first().click();
    await page.waitForSelector('.ahero__actions');
    await page.locator('button[aria-label^="More for"]').first().click();
    await shot(page, 'desktop-foreign-playlist-trackmenu', { wait: 500 });
    await page.keyboard.press('Escape');
    // pin a playlist from its page, then the Playlists library
    await page.click('.ahero__actions button[aria-label="More actions"]');
    await shot(page, 'desktop-playlist-menu', { wait: 300 });
    const pin = page.locator('.menu__item', { hasText: /^Pin/ });
    if (await pin.count()) { await pin.first().click(); await page.waitForTimeout(400); } else await page.keyboard.press('Escape');
    await page.goBack();
    await page.waitForSelector('.card__title');
    await shot(page, 'desktop-playlists', { wait: 900 });
    await page.goto(`${BASE}/albums`);
    await page.waitForSelector('.vgrid .card__title');
    await page.locator('.card__title').nth(3).click();
    await page.waitForSelector('.ahero__actions');
    await page.click('.ahero__actions button[aria-label="More actions"]');
    const pinA = page.locator('.menu__item', { hasText: /^Pin/ });
    if (await pinA.count()) { await pinA.first().click(); await page.waitForTimeout(400); } else await page.keyboard.press('Escape');
    await page.goBack();
    await page.waitForSelector('.vgrid .card__title');
    await shot(page, 'desktop-albums', { wait: 900 });
    // the reconnect hint when the login lacks the write permission (mock: ?scopes=old)
    await page.goto(`${liked}?scopes=old`);
    await page.waitForSelector('.ahero__actions');
    await shot(page, 'desktop-liked-oldscopes', { wait: 800 });
    await page.locator('button[aria-label^="More for"]').first().click();
    const rm2 = page.locator('.menu__item', { hasText: /Remove from Liked Songs/ });
    if (await rm2.count()) { await rm2.first().click(); await shot(page, 'desktop-liked-oldscopes-dialog', { wait: 400 }); await page.keyboard.press('Escape'); }
    await page.goto(`${BASE}/settings`);
    await page.waitForSelector('.statusrow');
    await shot(page, 'desktop-settings-oldscopes', { wait: 800 });
    await ctx.close();
  }
} finally {
  await browserGL?.close();
  await browser?.close();
  stop();
}
writeFileSync(join(out, `${prefix}overflow-sweep.json`), JSON.stringify(sweep, null, 2));
const problems = Object.entries(sweep).filter(([, v]) => v.docScroll || v.mainScroll || v.bad.length);
console.log(problems.length ? `OVERFLOW on ${problems.length} page(s):` : 'no phone overflow found');
for (const [k, v] of problems) console.log(' ', k, JSON.stringify(v));
