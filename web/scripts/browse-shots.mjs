// Screenshots for the browse/review-preview work. Serves dist via `vite preview` (mock mode), real Chromium on the GPU (ANGLE/Vulkan).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'shots');
mkdirSync(out, { recursive: true });
const PORT = 4191;
const BASE = `http://127.0.0.1:${PORT}`;
const preview = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const stop = () => { try { preview.kill('SIGTERM'); } catch { /* gone */ } };
process.on('exit', stop);
for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE)).ok) break; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 150)); }

const ARGS = ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'];
const shot = async (page, name, wait = 500) => { await page.waitForTimeout(wait); await page.screenshot({ path: join(out, name + '.png') }); console.log('shot', name); };
const FRAME_PAGE = '<!doctype html><meta charset=utf-8><body style="font:18px Georgia;max-width:560px;margin:40px auto;color:#222"><h1>The Harbour Review</h1><p><i>Glass Harbour</i> — a stand-in for an embeddable review page, served by the screenshot script.</p><p>A record that sounds like it was written while looking out at the water.</p></body>';

let browser;
try {
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ARGS });
  for (const [label, viewport] of [['desktop', { width: 1600, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const mobile = label === 'mobile';
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, hasTouch: mobile, isMobile: mobile });
    await ctx.route('https://example.org/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: FRAME_PAGE }));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
    const goAlbum = async () => {
      await page.goto(`${BASE}/?mock=1`);
      await page.waitForSelector('.card__title');
      await page.evaluate(() => { history.pushState({}, '', '/albums'); dispatchEvent(new PopStateEvent('popstate')); });
      await page.waitForSelector('.vgrid .card__title');
      await page.click('.vgrid .card__title >> text=Glass Harbour');
      await page.waitForSelector('.quote');
    };
    await goAlbum();

    // quote preview (summary with Wikipedia context)
    await page.locator('.quote').nth(2).scrollIntoViewIfNeeded();
    await page.locator('.quote').nth(2).click();
    await page.waitForSelector('.pv__panel');
    await shot(page, `browse-${label}-preview-quote`, 700);

    // original: embeddable (example.org) then blocked
    await page.click('text=Open original');
    await page.waitForSelector('.pv__framewrap iframe');
    await shot(page, `browse-${label}-preview-iframe`, 900);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.pv__panel', { state: 'detached' });

    // score preview -> blocked site
    if (!mobile) await page.locator('.recep__scores .srow').nth(2).click(); else await page.locator('.ahero__scores .score').nth(2).click();
    await page.waitForSelector('.pv__panel');
    await shot(page, `browse-${label}-preview-score`, 500);
    await page.click('text=Open original');
    await page.waitForSelector('.pv__state--blocked');
    await shot(page, `browse-${label}-preview-blocked`, 300);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.pv__panel', { state: 'detached' });

    // expanded reception + background
    await page.locator('.prose__clip').first().scrollIntoViewIfNeeded();
    await page.locator('.readmore').first().click();
    await page.waitForTimeout(450);
    await page.evaluate(() => { const m = document.querySelector('#main'); const t = document.querySelector('.prose__clip'); if (m && t) m.scrollTop = t.getBoundingClientRect().top - m.getBoundingClientRect().top + m.scrollTop - 130; });
    await shot(page, `browse-${label}-reception-expanded`, 400);

    // source line -> text preview
    await page.locator('.sourceline__btn').first().click();
    await page.waitForSelector('.pv__panel');
    await shot(page, `browse-${label}-preview-source`, 500);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.pv__panel', { state: 'detached' });

    // Tracks
    await page.goto(`${BASE}/tracks?mock=1`);
    await page.waitForSelector('.tk__name');
    await shot(page, `browse-${label}-tracks`, 700);
    if (!mobile) {
      await page.click('.tkhead__col >> text=Time');
      await shot(page, `browse-${label}-tracks-sorted`, 600);
    }

    // Genres + a genre page
    await page.goto(`${BASE}/genres?mock=1`);
    await page.waitForSelector('.gtile__name');
    await shot(page, `browse-${label}-genres`, 800);
    await page.click('.gtile >> nth=0');
    await page.waitForSelector('.vgrid .card__title');
    await shot(page, `browse-${label}-genre`, 600);

    // Home history rows + albums filters (desktop only)
    if (!mobile) {
      await page.goto(`${BASE}/?mock=1`);
      await page.waitForSelector('text=Recently played');
      await shot(page, `browse-${label}-home`, 900);
      await page.goto(`${BASE}/albums?mock=1`);
      await page.waitForSelector('.vgrid .card__title');
      await page.click('.chip--btn >> text=Label');
      await shot(page, `browse-${label}-albums-label`, 500);
    }
    await ctx.close();
  }
} finally {
  await browser?.close();
  stop();
}
