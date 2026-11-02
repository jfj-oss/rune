// Spotify screenshots in mock mode: node scripts/shots-spotify.mjs  (needs `pnpm build` first). GPU via ANGLE/Vulkan, never SwiftShader.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'shots');
mkdirSync(out, { recursive: true });
const PORT = 4174;
const BASE = `http://127.0.0.1:${PORT}`;
const preview = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const stop = () => { try { preview.kill('SIGTERM'); } catch { /* gone */ } };
process.on('exit', stop);
for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE)).ok) break; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 150)); }

const ARGS = ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'];
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ARGS });
const shot = async (page, name, wait = 500) => { await page.waitForTimeout(wait); await page.screenshot({ path: join(out, `spotify-${name}.png`) }); console.log('shot', name); };
const watch = (page) => { page.on('pageerror', (e) => console.log('PAGEERROR', e.message)); page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); }); };

try {
  // ---------- desktop ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    watch(page);
    await page.goto(`${BASE}/playlists?mock=1`);
    await page.waitForSelector('.plcard');
    await shot(page, 'desktop-playlists', 700);

    await page.locator('.plcard .card__title', { hasText: 'Liked Songs' }).click();
    await page.waitForSelector('.prow:not(.prow--head)');
    await shot(page, 'desktop-liked', 700);
    await page.evaluate(() => { document.querySelector('#main').scrollTop = 9000; });
    await shot(page, 'desktop-liked-scrolled', 700);
    const rows = await page.locator('.prow:not(.prow--head)').count();
    console.log('rendered rows after scroll (virtualized, of 4612):', rows);

    await page.goto(`${BASE}/playlists`);
    await page.locator('.plcard .card__title', { hasText: 'Morning Harbour' }).click();
    await page.waitForSelector('.prow:not(.prow--head)');
    await shot(page, 'desktop-playlist-detail', 700);

    // search with Spotify results
    await page.goto(`${BASE}/search?q=aster`);
    await page.waitForSelector('.card__title');
    await shot(page, 'desktop-search', 800);

    // Spotify catalogue album with Save, then Play on the PC zone -> "Play on…" sheet
    await page.locator('.card__title', { hasText: 'Glass Harbour (Deluxe Edition)' }).first().click();
    await page.waitForSelector('.ahero__actions .btn--primary');
    await page.waitForTimeout(500);
    await shot(page, 'desktop-album-save', 400);
    await page.click('.ahero__actions button:has-text("Save")');
    await page.waitForSelector('.ahero__actions button:has-text("Saved")');
    await shot(page, 'desktop-album-saved', 400);
    await page.click('.ahero__actions .btn--primary');
    await page.waitForSelector('.dialog--sheet');
    await shot(page, 'desktop-playon-sheet', 500);
    // pick "This browser (Spotify)" -> plays there
    await page.click('.sheet__opt:has-text("This browser")');
    await page.waitForTimeout(600);
    await shot(page, 'desktop-after-choice', 500);
    // Albums > Spotify chip now shows the saved album
    await page.goto(`${BASE}/albums?source=spotify`);
    await page.waitForSelector('.vgrid .card__title');
    await shot(page, 'desktop-albums-spotify', 700);
    await ctx.close();
  }
  // ---------- mobile ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    watch(page);
    await page.goto(`${BASE}/playlists?mock=1`);
    await page.waitForSelector('.plcard');
    await shot(page, 'mobile-playlists', 700);
    await page.locator('.plcard .card__title', { hasText: 'Liked Songs' }).tap();
    await page.waitForSelector('.prow:not(.prow--head)');
    await shot(page, 'mobile-liked', 700);
    await page.evaluate(() => { document.querySelector('#main').scrollTop = 700; });
    await shot(page, 'mobile-liked-scrolled', 500);
    // sheet on mobile: switch to the PC zone first, then play a Spotify album
    await page.evaluate(() => localStorage.setItem('rune.zone', JSON.stringify('pc')));
    await page.goto(`${BASE}/search?q=aster`);
    await page.waitForSelector('.card__title');
    await page.locator('.card__title', { hasText: 'Northern Cross EP' }).first().click();
    await page.waitForSelector('.ahero__actions .btn--primary');
    await page.waitForTimeout(400);
    await page.click('.ahero__actions .btn--primary');
    await page.waitForSelector('.dialog--sheet');
    await shot(page, 'mobile-playon-sheet', 500);
    await ctx.close();
  }
} finally {
  await browser.close();
  stop();
}
