// Discover + song radio DOM self-check in mock mode. Needs `pnpm -C web build` first.
// node scripts/shots-discover.mjs  — GPU via ANGLE/Vulkan, never SwiftShader, audio muted.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'shots');
mkdirSync(out, { recursive: true });
const PORT = 4393;
const BASE = `http://127.0.0.1:${PORT}`;
const preview = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  try { process.kill(preview.pid, 'SIGTERM'); } catch { /* already gone */ }
};
process.on('exit', stop);
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(BASE)).ok) break; } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 150));
}

const ARGS = ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'];
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ARGS });
const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
};
const shot = async (page, name, wait = 450) => {
  await page.waitForTimeout(wait);
  await page.screenshot({ path: join(out, `discover-${name}.png`) });
  console.log('shot', name);
};
const text = async (page, sel) => (await page.locator(sel).first().textContent())?.trim() ?? '';
const noOverflow = async (page, where) => {
  const v = await page.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, w: window.innerWidth }));
  assert.ok(v.sw <= v.w + 1, `${where}: horizontal overflow ${v.sw} > ${v.w}`);
};
const bottomClear = async (page, where) => {
  const v = await page.evaluate(() => {
    const main = document.querySelector('#main');
    if (main) main.scrollTop = main.scrollHeight;
    const rows = [...document.querySelectorAll('.drow:not(.drow--skel)')];
    const bar = document.querySelector('.npbar') ?? document.querySelector('.tabs');
    if (!rows.length || !bar) return { ok: false, reason: 'missing rows or bar' };
    const r = rows[rows.length - 1].getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    return { ok: r.bottom <= b.top + 1, rowBottom: Math.round(r.bottom), barTop: Math.round(b.top) };
  });
  assert.ok(v.ok, `${where}: last row hidden under fixed bottom bar (${JSON.stringify(v)})`);
};
const assertReal = (value, where) => {
  assert.ok(value.length > 3 && !/loading/i.test(value), `${where}: missing real text (${JSON.stringify(value)})`);
};

try {
  // ---------- desktop 1600x1000 ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    watch(page);
    await page.goto(`${BASE}/discover?mock=1`);
    await page.waitForSelector('.drow:not(.drow--skel)');
    assert.equal(await text(page, '.pagehead__title'), 'Discover');
    const heads = await page.locator('.discover__grouphead h2').allTextContents();
    assert.ok(heads.length >= 3 && heads.every((h) => h.includes('Because you listen to')), `unexpected groups: ${heads.join(' | ')}`);
    const titles = await page.locator('.drow__title').allTextContents();
    assert.ok(titles.length >= 12 && titles.every((t) => t.trim().length > 0), 'Discover rows need real song titles');
    assertReal(await text(page, '.drow__reason'), 'reason');
    console.log('desktop discover groups:', heads.join(' | '));
    await shot(page, 'desktop');
    await noOverflow(page, 'desktop discover');
    await bottomClear(page, 'desktop discover');

    // Refresh keeps the same feed and leaves a usable page.
    await page.getByRole('button', { name: /Refresh/ }).click();
    await page.waitForTimeout(900);
    assert.equal(await page.locator('.discover__group').count(), heads.length, 'refresh changed the group count');
    assert.ok(await page.locator('.discover__refresh').isEnabled(), 'refresh button stuck disabled');

    // Right-click a real album row, open Song radio from the shared menu.
    await page.goto(`${BASE}/albums`);
    await page.waitForSelector('.vgrid .card__title');
    await page.locator('.vgrid .card__title').first().click();
    await page.waitForSelector('.trow');
    const seedTitle = (await page.locator('.trow .trow__name').nth(2).textContent())?.trim() ?? '';
    assertReal(seedTitle, 'album seed title');
    await page.locator('.trow').nth(2).click({ button: 'right' });
    await page.waitForSelector('.ctxmenu');
    const menuBox = await page.locator('.ctxmenu').boundingBox();
    const npbarBox = await page.locator('.npbar').boundingBox();
    assert.ok(menuBox, 'context menu has no box');
    assert.ok(menuBox.x >= 0 && menuBox.y >= 0 && menuBox.x + menuBox.width <= 1600 && menuBox.y + menuBox.height <= 1000, `context menu off-screen: ${JSON.stringify(menuBox)}`);
    assert.ok(npbarBox && menuBox.y + menuBox.height <= npbarBox.y + 1, `context menu runs under the player bar: ${JSON.stringify(menuBox)}`);
    assert.ok(await page.getByRole('menuitem', { name: 'Song radio' }).isVisible(), 'Song radio missing from the track menu');
    await shot(page, 'context-menu', 200);
    await page.getByRole('menuitem', { name: 'Song radio' }).click();
    await page.waitForSelector('.radio');
    await page.waitForSelector('.radio .drow:not(.drow--skel)');
    assert.ok((await text(page, '.radio__seedtxt h2')) === seedTitle, 'radio seed title does not match the clicked song');
    assertReal(await text(page, '.radio__seedtxt p'), 'radio seed artist');
    assert.ok((await text(page, '.radio__seedtxt small')).includes('Spotify'), 'radio needs the Spotify explanation');
    assert.ok(await page.getByRole('button', { name: 'Play all' }).isVisible(), 'Play all missing');
    const reasons = await page.locator('.radio .drow__reason').allTextContents();
    assert.ok(reasons.length > 0 && reasons.every((r) => r.includes('Similar to')), 'radio rows need a reason');
    console.log('radio rows:', await page.locator('.radio .drow').count(), 'first reason:', reasons[0]);
    await shot(page, 'radio-desktop');
    await noOverflow(page, 'desktop radio');

    // Add to playlist opens the picker above the radio; Escape closes only the picker.
    await page.locator('.radio .drow').first().getByLabel(/to playlist/).click();
    await page.waitForSelector('.dialog--picker');
    assert.ok(await page.getByRole('dialog', { name: 'Add to playlist' }).isVisible(), 'playlist picker did not open');
    await shot(page, 'playlist-picker', 250);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.dialog--picker', { state: 'detached' });
    assert.ok(await page.locator('.radio').isVisible(), 'Escape closed the radio along with the picker');

    // Dismiss removes one suggestion immediately.
    const before = await page.locator('.radio .drow:not(.drow--skel)').count();
    await page.locator('.radio .drow:not(.drow--skel)').first().locator('.drow__x').click();
    await page.waitForFunction((n) => document.querySelectorAll('.radio .drow:not(.drow--skel)').length === n - 1, before);
    console.log('dismiss removed one radio row:', before, '→', await page.locator('.radio .drow:not(.drow--skel)').count());
    await page.getByLabel('Close song radio').click();
    await page.waitForSelector('.radio', { state: 'detached' });

    // The same menu must open from every required row type.
    const checkMenu = async (where) => {
      await page.waitForSelector('.ctxmenu');
      assert.ok(await page.getByRole('menuitem', { name: 'Song radio' }).isVisible(), `${where}: Song radio missing`);
      const box = await page.locator('.ctxmenu').boundingBox();
      const bar = await page.locator('.npbar').boundingBox();
      assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1600, `${where}: menu off-screen`);
      assert.ok(bar && box.y + box.height <= bar.y + 1, `${where}: menu runs under the player bar`);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.ctxmenu', { state: 'detached' });
      console.log('context menu ok on', where);
    };

    await page.goto(`${BASE}/tracks`);
    await page.waitForSelector('.tk .tk__name');
    await page.locator('.tk:has(.tk__name)').nth(1).click({ button: 'right' });
    await checkMenu('Tracks');

    await page.goto(`${BASE}/search?q=Glass`);
    await page.waitForSelector('.tlist__row');
    await page.locator('.tlist__row').first().click({ button: 'right' });
    await checkMenu('search');

    await page.goto(`${BASE}/playlists`);
    await page.waitForSelector('.plcard .card__title');
    await page.locator('.plcard .card__title').first().click();
    await page.waitForSelector('.prow:not(.prow--head)');
    await page.locator('.prow:not(.prow--head)').first().click({ button: 'right' });
    await checkMenu('playlist');

    await page.locator('.npbar').getByLabel('Queue', { exact: true }).click();
    await page.waitForSelector('.qrow');
    await page.locator('.qrow').first().click({ button: 'right' });
    await checkMenu('queue');
    await page.locator('.npbar').getByLabel('Queue', { exact: true }).click();
    await page.waitForTimeout(300);

    // Explicit rate-limit state.
    await page.goto(`${BASE}/discover?mock=1&mockRateLimit=1`);
    await page.waitForSelector('.discover__limit');
    const limit = await text(page, '.discover__limit');
    assert.ok(limit.includes('Spotify is taking a break'), 'rate-limit heading missing');
    assert.match(limit, /rate-limiting rune — try again after \d{1,2}:\d{2}/i, `rate-limit message lacks a time: ${limit}`);
    await shot(page, 'rate-limit');
    await noOverflow(page, 'desktop rate-limit');
    await ctx.close();
  }

  // ---------- mobile 390x844 ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    watch(page);
    await page.goto(`${BASE}/discover?mock=1`);
    await page.waitForSelector('.drow:not(.drow--skel)');
    assert.equal(await text(page, '.pagehead__title'), 'Discover');
    assert.ok((await page.locator('.discover__grouphead h2').count()) >= 3, 'mobile feed needs its groups');
    const tabs = await page.evaluate(() => {
      const seg = document.querySelector('.seg--tabs');
      if (!seg) return { ok: false, reason: 'no tabs' };
      return {
        ok: seg.scrollWidth <= seg.clientWidth + 1,
        labels: [...seg.querySelectorAll('a')].map((a) => a.textContent?.trim()),
        visible: [...seg.querySelectorAll('a')].every((a) => { const r = a.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1; }),
      };
    });
    assert.ok(tabs.ok && tabs.visible, `mobile library tabs overflow: ${JSON.stringify(tabs)}`);
    assert.deepEqual(tabs.labels, ['Albums', 'Artists', 'Tracks', 'Genres', 'Playlists', 'Discover']);
    console.log('mobile tabs:', tabs.labels.join(', '));
    await shot(page, 'mobile');
    await noOverflow(page, 'mobile discover');
    await bottomClear(page, 'mobile discover');

    // Touch path: ⋯ menu → Song radio → bottom sheet.
    await page.locator('.drow').first().getByLabel(/More for/).tap();
    await page.waitForSelector('.pop__panel .menu');
    assert.ok(await page.getByRole('menuitem', { name: 'Song radio' }).isVisible(), 'mobile track menu lacks Song radio');
    await shot(page, 'mobile-menu', 250);
    await page.getByRole('menuitem', { name: 'Song radio' }).tap();
    await page.waitForSelector('.radio--sheet');
    await page.waitForSelector('.radio .drow:not(.drow--skel)');
    assertReal(await text(page, '.radio__seedtxt h2'), 'mobile radio seed');
    const sheet = await page.evaluate(() => {
      const el = document.querySelector('.radio');
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), sw: el.scrollWidth, cw: el.clientWidth, vw: innerWidth, vh: innerHeight };
    });
    assert.ok(sheet.top >= 0 && sheet.bottom <= sheet.vh + 1 && sheet.sw <= sheet.cw + 1, `bottom sheet out of bounds: ${JSON.stringify(sheet)}`);
    await shot(page, 'radio-mobile');
    await noOverflow(page, 'mobile radio');
    await page.getByLabel('Close song radio').tap();
    await page.waitForSelector('.radio', { state: 'detached' });
    await ctx.close();
  }

  assert.deepEqual(errors, [], `browser errors:\n${errors.join('\n')}`);
  console.log('DISCOVER DOM SELF-CHECK PASSED');
} finally {
  await browser.close();
  stop();
}
