// Playlist + zone screenshots in mock mode: node scripts/shots-playlists.mjs  (needs `pnpm build` first). GPU via ANGLE/Vulkan, never SwiftShader.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'shots');
mkdirSync(out, { recursive: true });
const PORT = 4391;
const BASE = `http://127.0.0.1:${PORT}`;
const preview = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const stop = () => { try { preview.kill('SIGTERM'); } catch { /* gone */ } };
process.on('exit', stop);
for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE)).ok) break; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 150)); }

const ARGS = ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'];
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ARGS });
const shot = async (page, name, wait = 500) => { await page.waitForTimeout(wait); await page.screenshot({ path: join(out, `pl-${name}.png`) }); console.log('shot', name); };
const watch = (page) => { page.on('pageerror', (e) => console.log('PAGEERROR', e.message)); page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); }); };
const only = process.argv[2];

try {
  // ---------- desktop ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    watch(page);
    await page.goto(`${BASE}/playlists?mock=1`);
    await page.waitForSelector('.plcard');
    await shot(page, 'playlists-desktop', 700);

    // new playlist dialog
    await page.getByRole('button', { name: 'New playlist' }).first().click();
    await page.waitForSelector('.dialog--form');
    await page.fill('.dialog--form input.field__input', 'Sunday drive');
    await shot(page, 'new-dialog', 300);
    await page.keyboard.press('Escape');

    // smart playlist builder
    await page.getByLabel('More playlist actions').click();
    await page.getByRole('menuitem', { name: /smart playlist/ }).click();
    await page.waitForSelector('.dialog--smart');
    await page.fill('.dialog--smart input[placeholder^="Jazz"]', 'Newer than 2005, no Spotify');
    const dlg = page.locator('.dialog--smart');
    await dlg.getByLabel('Field').first().selectOption('year');
    await dlg.getByLabel('Operator').first().selectOption('gte');
    await dlg.getByLabel('Value').first().fill('2005');
    await dlg.getByRole('button', { name: 'Add rule' }).click();
    await dlg.getByLabel('Field').nth(1).selectOption('source');
    await dlg.getByLabel('Operator').nth(1).selectOption('eq');
    await dlg.getByLabel('Value').nth(1).selectOption('local');
    await shot(page, 'smart-builder', 900);
    await page.keyboard.press('Escape');

    // add-to-playlist submenu on an album track row
    await page.goto(`${BASE}/albums`);
    await page.waitForSelector('.vgrid .card__title');
    await page.locator('.vgrid .card__title').first().click();
    await page.waitForSelector('.trow');
    await page.locator('.trow').nth(2).hover();
    await page.locator('.trow').nth(2).getByLabel(/More for/).click();
    await page.getByRole('menuitem', { name: /Add to playlist/ }).click();
    await shot(page, 'add-submenu', 400);
    // pick the first playlist and capture the toast
    await page.locator('.menu__sub .menu__item').nth(1).click();
    await shot(page, 'add-toast', 400);

    // mixed rune playlist detail
    await page.goto(`${BASE}/playlists`);
    await page.locator('.plcard .card__title', { hasText: 'Coast road' }).click();
    await page.waitForSelector('.prow:not(.prow--head)');
    await shot(page, 'detail-mixed', 800);
    // select two rows
    await page.locator('.prow:not(.prow--head)').nth(1).click();
    await page.locator('.prow:not(.prow--head)').nth(3).click({ modifiers: ['Shift'] });
    await shot(page, 'detail-selected', 300);
    await page.keyboard.press('Escape');
    // drag row 1 to row 4
    const grip = page.locator('.prow__grip').nth(1);
    const gb = await grip.boundingBox();
    await page.mouse.move(gb.x + 8, gb.y + 8);
    await page.mouse.down();
    await page.mouse.move(gb.x + 8, gb.y + 8 + 56 * 2.2, { steps: 8 });
    await shot(page, 'detail-dragging', 250);
    await page.mouse.up();
    await page.waitForTimeout(500);
    const firstTitles = await page.locator('.prow:not(.prow--head) .prow__name').allTextContents();
    console.log('order after drag:', firstTitles.slice(0, 5).join(' | '));

    // delete confirm
    await page.getByLabel('More actions').click();
    await page.getByRole('menuitem', { name: 'Delete playlist' }).click();
    await shot(page, 'delete-confirm', 300);
    await page.keyboard.press('Escape');

    // smart playlist detail
    await page.goto(`${BASE}/playlists`);
    await page.locator('.plcard .card__title', { hasText: 'Everything since 2005' }).click();
    await page.waitForSelector('.prow:not(.prow--head)');
    await shot(page, 'detail-smart', 800);

    // Spotify playlist with overlay rows (MYPC)
    await page.goto(`${BASE}/playlists`);
    await page.locator('.plcard .card__title', { hasText: 'MYPC' }).click();
    await page.waitForSelector('.prow:not(.prow--head)');
    await shot(page, 'detail-spotify-overlay', 800);
    // plain Spotify playlist (no overlay)
    await page.goto(`${BASE}/playlists`);
    await page.locator('.plcard .card__title', { hasText: 'Morning Harbour' }).click();
    await page.waitForSelector('.prow:not(.prow--head)');
    await shot(page, 'detail-spotify', 800);

    // queue: save as playlist
    await page.getByLabel('Open queue').or(page.locator('button[aria-label*="ueue"]').first()).first().click().catch(() => {});
    await page.waitForTimeout(400);
    const save = page.getByLabel('Save queue as playlist');
    if (await save.count()) { await save.click(); await shot(page, 'queue-save', 400); await page.keyboard.press('Escape'); }

    // zone picker (queue closed first)
    await page.keyboard.press('Escape');
    await page.getByLabel('Close queue').click().catch(() => {});
    await page.waitForTimeout(400);
    await page.locator('.zonebtn').first().click();
    await shot(page, 'zone-picker', 500);
    await ctx.close();
  }

  // ---------- mobile ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    watch(page);
    await page.goto(`${BASE}/playlists?mock=1`);
    await page.waitForSelector('.plcard');
    await shot(page, 'm-playlists', 600);
    await page.locator('.plcard .card__title', { hasText: 'Coast road' }).click();
    await page.waitForSelector('.prow:not(.prow--head)');
    await shot(page, 'm-detail', 800);
    await page.evaluate(() => { const m = document.querySelector('#main'); const t = document.querySelector('.ptools'); m.scrollTop = t.getBoundingClientRect().top - m.getBoundingClientRect().top + m.scrollTop - 60; });
    await page.waitForTimeout(300);
    await shot(page, 'm-detail-list', 200);
    await page.getByRole('button', { name: 'Select', exact: true }).tap();
    await page.locator('.prow:not(.prow--head)').nth(1).tap({ position: { x: 290, y: 28 } });
    await page.locator('.prow:not(.prow--head)').nth(2).tap({ position: { x: 290, y: 28 } });
    await shot(page, 'm-detail-select', 300);
    await page.getByRole('button', { name: 'Clear selection' }).tap();
    // add-to-playlist sheet from a track row menu on an album
    await page.goto(`${BASE}/albums`);
    await page.waitForSelector('.vgrid .card__title');
    await page.locator('.vgrid .card__title').first().tap();
    await page.waitForSelector('.trow');
    await page.locator('.trow').nth(1).getByLabel(/More for/).tap();
    await page.getByRole('menuitem', { name: /Add to playlist/ }).tap();
    await page.waitForSelector('.dialog--picker');
    await shot(page, 'm-add-sheet', 500);
    await ctx.close();
  }
} finally {
  await browser.close();
  stop();
}
