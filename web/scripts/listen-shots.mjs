// DOM self-check + screenshots for rune radio, internet radio, waveforms and loudness settings.
// Serves the production build with `vite preview` in mock mode and uses Chromium on the GPU.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'shots');
mkdirSync(out, { recursive: true });
const PORT = 4195;
const BASE = `http://127.0.0.1:${PORT}`;

const preview = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const stopPreview = () => { try { preview.kill('SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stopPreview);
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(BASE)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 150));
}

const ARGS = ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'];
const failures = [];
const check = (ok, message) => {
  if (ok) console.log('  ok  ', message);
  else { failures.push(message); console.log('  FAIL', message); }
};
const shot = async (page, name, wait = 450) => {
  await page.waitForTimeout(wait);
  await page.screenshot({ path: join(out, name + '.png') });
  console.log('  shot', name);
};
const text = async (loc) => ((await loc.textContent()) ?? '').trim();
const waitText = (page, selector, re, timeout = 6000) =>
  page.waitForFunction(([sel, src]) => new RegExp(src).test(document.querySelector(sel)?.textContent ?? ''), [selector, re.source], { timeout });

async function overflow(page, label) {
  const m = await page.evaluate(() => ({
    scroll: document.scrollingElement?.scrollWidth ?? 0,
    body: document.body.scrollWidth,
    win: window.innerWidth,
    mainOver: (() => { const el = document.querySelector('.main'); return el ? el.scrollWidth - el.clientWidth : 0; })(),
  }));
  check(m.scroll <= m.win + 1 && m.body <= m.win + 1 && m.mainOver <= 1, `${label}: no horizontal overflow (${m.scroll}/${m.body}/${m.win}, main +${m.mainOver})`);
}

/** When the page is scrolled to its end, the last radio card must sit above the fixed player. */
async function bottomClear(page, label, cardSelector = '.rgrid .rcard', barSelector = '.npbar, .mini') {
  await page.locator('#main').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(250);
  const m = await page.evaluate(([cardSel, barSel]) => {
    const cards = document.querySelectorAll(cardSel);
    const last = cards[cards.length - 1];
    const bar = document.querySelector(barSel);
    if (!last || !bar) return null;
    return { card: last.getBoundingClientRect().bottom, bar: bar.getBoundingClientRect().top };
  }, [cardSelector, barSelector]);
  if (!m) { check(false, `${label}: found a last card and the player bar`); return; }
  check(m.card <= m.bar + 1, `${label}: last card (${Math.round(m.card)}) is above the player (${Math.round(m.bar)})`);
  await page.locator('#main').evaluate((el) => { el.scrollTop = 0; });
}

async function noConsoleErrors(errors, label) {
  check(errors.length === 0, `${label}: no console errors${errors.length ? ` — ${errors.slice(0, 3).join(' | ')}` : ''}`);
}

let browser;
try {
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ARGS });

  // ---------------------------------------------------------------- desktop
  {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERROR', e.message); });
    page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.log('CONSOLE', m.text()); } });

    await page.goto(`${BASE}/radio?mock=1`);
    await page.waitForSelector('.rgrid .rcard__name');
    await page.waitForFunction(() => document.querySelectorAll('.rgrid .rcard').length >= 10);
    check(await page.locator('.page--radio h1').innerText() === 'Radio', 'desktop radio: page heading');
    check((await page.locator('.rgrid .rcard__name').count()) >= 10, 'desktop radio: station cards render');
    check((await text(page.locator('.rgrid .rcard__name').first())).length > 0, 'desktop radio: station name has text');
    check((await page.locator('.rgrid .rcard__tags').first().innerText()).length > 0, 'desktop radio: station tags render');
    check(/\d+ kbps/.test(await page.locator('.rgrid .rcard__meta').first().innerText()), 'desktop radio: bitrate renders');
    check(await page.locator('.rfavrow .rcard').count() === 2, 'desktop radio: favourites row starts with 2 stations');
    await overflow(page, 'desktop radio');
    await shot(page, 'listen-desktop-radio', 700);

    // search by country (mock matches name/tag/country)
    await page.locator('.radio__search input').fill('Norway');
    await page.waitForFunction(() => {
      const names = [...document.querySelectorAll('.rgrid .rcard__name')].map((n) => n.textContent ?? '');
      return names.length > 0 && names.includes('Northlight Jazz') && names.includes('Fjord Drift') && !names.includes('Grid Lines FM');
    }, null, { timeout: 8000 });
    const norway = await page.locator('.rgrid .rcard__name').allInnerTexts();
    check(norway.includes('Northlight Jazz') && norway.includes('Fjord Drift'), `desktop radio: country search finds Norway stations (${norway.join(', ')})`);
    await page.locator('.radio__search .search__clear').click();
    await page.waitForFunction(() => (document.querySelector('.rgrid')?.textContent ?? '').includes('Grid Lines FM'), null, { timeout: 6000 });

    // genre chip
    await page.locator('.rchips button', { hasText: 'ambient' }).click();
    await page.waitForFunction(() => (document.querySelector('.rgrid')?.textContent ?? '').includes('Slow Light Ambient') && !(document.querySelector('.rgrid')?.textContent ?? '').includes('Grid Lines FM'), null, { timeout: 6000 });
    check(true, 'desktop radio: ambient genre chip filters cards');
    await page.locator('.rchips button', { hasText: 'ambient' }).click();
    await page.waitForFunction(() => (document.querySelector('.rgrid')?.textContent ?? '').includes('Grid Lines FM'), null, { timeout: 6000 });

    // favourites heart
    const harbour = page.locator('.rgrid .rcard', { hasText: 'Harbour Report' });
    await harbour.locator('.rcard__fav').click();
    await page.waitForFunction(() => (document.querySelector('.rfavrow')?.textContent ?? '').includes('Harbour Report'), null, { timeout: 6000 });
    check(await page.locator('.rfavrow .rcard').count() === 3, 'desktop radio: heart adds the station to favourites');
    check(await harbour.locator('.rcard__fav').getAttribute('aria-pressed') === 'true', 'desktop radio: heart is pressed');

    // play a live station
    await page.locator('.rgrid .rcard', { hasText: 'Grid Lines FM' }).locator('.rcard__main').click();
    await page.waitForSelector('.npbar .seek--live', { timeout: 6000 });
    check((await text(page.locator('.npbar .seek--live .livepill'))) === 'LIVE', 'desktop station: LIVE pill in the player bar');
    check(await page.locator('.npbar .seek__live').count() === 1, 'desktop station: no seek bar for a live stream');
    check(await page.locator('.npbar .wave, .npbar .slider--seek').count() === 0, 'desktop station: waveform and slider are both absent');
    check((await text(page.locator('.npbar__title'))) === 'Grid Lines FM', 'desktop station: station name in the bar');
    await shot(page, 'listen-desktop-radio-playing', 650);

    await page.locator('.npbar__art').click();
    await page.waitForSelector('.np');
    check(await page.locator('.np .seek--live').count() === 1, 'desktop station: Now Playing has no seek bar');
    check((await text(page.locator('.np .np__title'))) === 'Grid Lines FM', 'desktop station: Now Playing title is the station');
    check(await page.locator('.np .livepill').count() >= 1, 'desktop station: Now Playing shows LIVE');
    check(await page.locator('.np .wave, .np .slider--seek').count() === 0, 'desktop station: Now Playing has no seek controls');
    check(await page.locator('.np__reason').count() === 0, 'desktop station: no rune-radio reason on a directly played station');
    const pillBox = await page.locator('.np__panel > .livepill').boundingBox();
    check(!!pillBox && pillBox.width < 120, `desktop station: LIVE badge hugs its text (${Math.round(pillBox?.width ?? 0)}px)`);
    await shot(page, 'listen-desktop-np-live', 600);
    await page.locator('.np button[aria-label="Close Now Playing"]').click();
    await page.waitForSelector('.np', { state: 'detached' });

    await page.locator('.npbar button[aria-label="Queue"]').click();
    await page.waitForSelector('.drawer.is-open .qrow');
    check((await text(page.locator('.drawer.is-open .qrow.is-current .qrow__sub'))) === 'Grid Lines FM', 'desktop queue: live row names the station');
    check((await text(page.locator('.drawer.is-open .qrow__dur').first())) === 'LIVE', 'desktop queue: live row has no fake duration');
    check(await page.locator('.drawer.is-open .qrow__reason').count() === 0, 'desktop queue: a directly played station has no rune-radio reason');
    await shot(page, 'listen-desktop-queue-live', 400);
    await page.locator('.drawer.is-open button[aria-label="Close queue"]').click();

    // --------------------------------------------------------- waveform
    await page.goto(`${BASE}/albums?mock=1`);
    await page.waitForSelector('.vgrid .card__title');
    await page.locator('.vgrid .card__title', { hasText: 'Glass Harbour' }).first().click();
    await page.waitForSelector('.trow');
    await page.locator('.trow__num').first().click();
    await page.waitForSelector('.npbar .seek--wave .wave canvas', { timeout: 8000 });
    const canvasSize = await page.locator('.npbar .wave canvas').evaluate((c) => ({ w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight }));
    check(canvasSize.w > 0 && canvasSize.h > 0 && canvasSize.cw > 0, `desktop waveform: canvas has a backing store (${canvasSize.w}x${canvasSize.h})`);
    const waveBox = await page.locator('.npbar .wave').boundingBox();
    check(!!waveBox && waveBox.width > 200, 'desktop waveform: bar waveform is wide enough');
    if (waveBox) {
      await page.mouse.move(waveBox.x + waveBox.width * 0.65, waveBox.y + waveBox.height / 2);
      await page.waitForTimeout(150);
      const tip = page.locator('.npbar .wave__tip');
      check(await tip.isVisible(), 'desktop waveform: hover shows a time tooltip');
      check(/^\d+:\d\d$/.test(await text(tip)), `desktop waveform: tooltip is a time (${await text(tip)})`);
      await page.mouse.click(waveBox.x + waveBox.width * 0.6, waveBox.y + waveBox.height / 2);
      await page.waitForTimeout(450);
      const t = await text(page.locator('.npbar .seek__t').first());
      check(!/^0:0\d$/.test(t), `desktop waveform: click seeks into the track (left time ${t})`);
    }
    await shot(page, 'listen-desktop-waveform', 350);
    await page.locator('.npbar__art').click();
    await page.waitForSelector('.np .seek--np .wave canvas', { timeout: 8000 });
    check(await page.locator('.np .wave').count() === 1, 'desktop waveform: Now Playing uses the waveform');
    const npWave = await page.locator('.np .wave canvas').evaluate((c) => ({ h: c.getBoundingClientRect().height, w: c.getBoundingClientRect().height }));
    check(npWave.h > 40, `desktop waveform: Now Playing waveform is taller (${Math.round(npWave.h)}px)`);
    await shot(page, 'listen-desktop-np-wave', 500);
    await page.locator('.np button[aria-label="Close Now Playing"]').click();
    await page.waitForSelector('.np', { state: 'detached' });

    // start rune radio from a track menu
    await page.locator('.trow__menu button[aria-label^="More for"]').first().click();
    await page.waitForSelector('.pop__panel');
    check(await page.locator('.pop__panel', { hasText: 'Start radio' }).count() === 1, 'desktop track menu: Start radio');
    await page.locator('.pop__panel .menu__item', { hasText: 'Start radio' }).click();
    await page.waitForTimeout(1200);
    await page.locator('.npbar button[aria-label="Queue"]').click();
    await page.waitForSelector('.drawer.is-open .qrow__reason', { timeout: 8000 });
    const reasons = await page.locator('.drawer.is-open .qrow__reason').allInnerTexts();
    check(reasons.length >= 2 && reasons.every((r) => r.trim().length > 0), `desktop rune radio: queue shows pick reasons (${reasons.slice(0, 3).join(' / ')})`);
    check((await page.locator('.drawer.is-open .qrow').count()) >= 5, 'desktop rune radio: a full radio queue was added');
    await shot(page, 'listen-desktop-queue-radio', 400);
    await page.locator('.drawer.is-open button[aria-label="Close queue"]').click();
    await page.locator('.npbar__art').click();
    await page.waitForSelector('.np__reason');
    check(/^Radio pick — .+/.test(await text(page.locator('.np__reason'))), `desktop Now Playing: radio pick reason (${await text(page.locator('.np__reason'))})`);
    await shot(page, 'listen-desktop-np-reason', 500);
    await page.locator('.np button[aria-label="Close Now Playing"]').click();

    // album and artist “…” menus
    await page.locator('.ahero__actions button[aria-label="More actions"]').click();
    check(await page.locator('.pop__panel .menu__item', { hasText: 'Start radio' }).count() === 1, 'desktop album menu: Start radio');
    await page.keyboard.press('Escape');
    await page.locator('.ahero__meta a').first().click();
    await page.waitForSelector('.arthero');
    await page.locator('.arthero button[aria-label="More actions"]').click();
    check(await page.locator('.pop__panel .menu__item', { hasText: 'Start radio' }).count() === 1, 'desktop artist menu: Start radio');
    await page.keyboard.press('Escape');

    // settings: volume levelling + auto-radio
    await page.locator('.topbar button[aria-label="Settings"]').click();
    await page.waitForSelector('.vlevel .seg--level');
    const levels = await page.locator('.vlevel .seg--level button').allInnerTexts();
    check(levels.join('|') === 'Off|Per track|Per album', `desktop settings: volume levelling choices (${levels.join(' / ')})`);
    check(await page.locator('.menu__item[role="menuitemcheckbox"]').getAttribute('aria-checked') === 'true', 'desktop settings: auto-radio starts on');
    await page.locator('.vlevel .seg--level button', { hasText: 'Per track' }).click();
    await page.waitForFunction(() => document.querySelector('.vlevel .seg--level button[aria-checked="true"]')?.textContent === 'Per track', null, { timeout: 4000 });
    check(true, 'desktop settings: Per track becomes selected');
    await page.locator('.menu__item[role="menuitemcheckbox"]').click();
    await page.waitForFunction(() => document.querySelector('.menu__item[role="menuitemcheckbox"]')?.getAttribute('aria-checked') === 'false');
    check(true, 'desktop settings: auto-radio toggle turns off');
    await shot(page, 'listen-desktop-settings', 350);
    await page.keyboard.press('Escape');

    // desktop bottom-bar clearance on the radio page
    await page.goto(`${BASE}/radio?mock=1`);
    await page.waitForSelector('.rgrid .rcard__name');
    await bottomClear(page, 'desktop radio', '.rgrid .rcard', '.npbar');
    await noConsoleErrors(errors, 'desktop');
    await ctx.close();
  }

  // ---------------------------------------------------------------- mobile
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERROR', e.message); });
    page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.log('CONSOLE', m.text()); } });

    await page.goto(`${BASE}/radio?mock=1`);
    await page.waitForSelector('.rgrid .rcard__name');
    await page.waitForFunction(() => document.querySelectorAll('.rgrid .rcard').length >= 6);
    await page.waitForSelector('.mini');
    const radioTab = page.locator('.seg--tabs a', { hasText: 'Radio' });
    check(await radioTab.getAttribute('aria-selected') === 'true', 'mobile radio: Radio library tab is active');
    check(await page.locator('.tabs a', { hasText: 'Library' }).getAttribute('class') === 'tab is-active', 'mobile radio: Library bottom tab is active');
    await overflow(page, 'mobile radio');
    await bottomClear(page, 'mobile radio', '.rgrid .rcard', '.mini');
    await shot(page, 'listen-mobile-radio', 600);

    await page.locator('.radio__search input').fill('classical');
    await page.waitForFunction(() => (document.querySelector('.rgrid')?.textContent ?? '').includes('Sostenuto Classical'), null, { timeout: 6000 });
    check(true, 'mobile radio: search finds a classical station');
    await overflow(page, 'mobile radio search');
    await shot(page, 'listen-mobile-radio-search', 400);
    await page.locator('.radio__search .search__clear').click();
    await page.waitForTimeout(700);

    await page.locator('.rgrid .rcard', { hasText: 'Sostenuto Classical' }).locator('.rcard__main').click();
    await page.waitForFunction(() => (document.querySelector('.mini')?.textContent ?? '').includes('LIVE'), null, { timeout: 6000 });
    check((await text(page.locator('.mini__txt'))).includes('Sostenuto Classical'), 'mobile station: mini player shows the station and LIVE');
    check(await page.locator('.mini__progress').count() === 0, 'mobile station: mini player has no fake progress line');
    await shot(page, 'listen-mobile-radio-playing', 500);

    await page.locator('.mini__main').click();
    await page.waitForSelector('.np');
    check(await page.locator('.np .seek--live').count() === 1, 'mobile station: Now Playing is live (no seek)');
    check(await page.locator('.np .livepill').count() >= 1, 'mobile station: Now Playing shows LIVE');
    await overflow(page, 'mobile Now Playing live');
    await shot(page, 'listen-mobile-np-live', 500);
    await page.locator('.np button[aria-label="Close Now Playing"]').click();
    await page.waitForSelector('.np', { state: 'detached' });

    // local track waveform in the mobile Now Playing sheet
    await page.goto(`${BASE}/albums?mock=1`);
    await page.waitForSelector('.vgrid .card__title');
    await page.locator('.vgrid .card__title', { hasText: 'Glass Harbour' }).first().click();
    await page.waitForSelector('.trow');
    await page.locator('.trow__num').first().click();
    await page.waitForSelector('.mini');
    await page.locator('.mini__main').click();
    await page.waitForSelector('.np .seek--np .wave canvas', { timeout: 8000 });
    const mw = await page.locator('.np .wave canvas').evaluate((c) => ({ w: c.width, h: c.getBoundingClientRect().height }));
    check(mw.w > 0 && mw.h > 30, `mobile waveform: Now Playing canvas renders (${mw.w}px wide, ${Math.round(mw.h)}px tall)`);
    await overflow(page, 'mobile Now Playing waveform');
    await shot(page, 'listen-mobile-np-wave', 500);

    await noConsoleErrors(errors, 'mobile');
    await ctx.close();
  }
} finally {
  await browser?.close();
  stopPreview();
}

console.log(`\n${failures.length ? `${failures.length} FAILURE(S)` : 'ALL CHECKS PASSED'}`);
if (failures.length) {
  for (const f of failures) console.log(' -', f);
  process.exitCode = 1;
}
