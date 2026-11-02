// Self-check + screenshots for the discover/people/editions/stats/dupes/settings work.
// Serves dist via `vite preview` (mock mode) and drives real Chromium (ANGLE/Vulkan, muted).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'shots');
mkdirSync(out, { recursive: true });
const PORT = 4193;
const BASE = `http://127.0.0.1:${PORT}`;
const preview = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const stop = () => { try { if (preview.pid) process.kill(preview.pid, 'SIGTERM'); } catch { /* gone */ } };
process.on('exit', stop);
for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE)).ok) break; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 150)); }

const ARGS = ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'];
const results = [];
const failures = [];
const ok = (label, msg) => results.push(`ok   ${label} — ${msg}`);
const bad = (label, msg) => { failures.push(`${label} — ${msg}`); results.push(`FAIL ${label} — ${msg}`); };

async function audit(page, label, { texts = [], sels = [] }) {
  await page.waitForTimeout(300);
  // innerText reflects CSS text-transform (section headings are uppercased), so compare case-insensitively.
  const body = (await page.locator('body').innerText()).toLowerCase();
  for (const t of texts) {
    if (!body.includes(t.toLowerCase())) bad(label, `missing text “${t}”`);
  }
  for (const s of sels) {
    if ((await page.locator(s).count()) === 0) bad(label, `missing selector ${s}`);
  }
  const dims = await page.evaluate(() => {
    const m = document.querySelector('.main');
    return {
      docOverflow: (document.scrollingElement?.scrollWidth ?? 0) - window.innerWidth,
      mainOverflow: m ? m.scrollWidth - m.clientWidth : 0,
    };
  });
  if (dims.docOverflow > 1) bad(label, `document overflows horizontally by ${dims.docOverflow}px`);
  if (dims.mainOverflow > 1) bad(label, `main scrolls horizontally by ${dims.mainOverflow}px`);

  const bottom = await page.evaluate(async () => {
    const m = document.querySelector('.main');
    if (!m) return { error: 'no .main' };
    m.scrollTop = m.scrollHeight;
    await new Promise((r) => setTimeout(r, 220));
    const pg = document.querySelector('.main .page');
    const last = pg?.lastElementChild;
    if (!last) return { error: 'no page content' };
    const fixed = [...document.querySelectorAll('.tabs, .mini, .npbar')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.width > 0;
    });
    const barTop = fixed.length ? Math.min(...fixed.map((el) => el.getBoundingClientRect().top)) : window.innerHeight;
    const rect = last.getBoundingClientRect();
    return { lastBottom: rect.bottom, barTop, gap: barTop - rect.bottom, atBottom: Math.abs(m.scrollHeight - m.clientHeight - m.scrollTop) < 3 };
  });
  if (bottom.error) bad(label, bottom.error);
  else {
    if (!bottom.atBottom) bad(label, 'main did not scroll to the bottom');
    if (bottom.gap < -1) bad(label, `last content sits ${Math.round(-bottom.gap)}px under the fixed bottom bar`);
    else ok(label, `no overflow; content clears the bottom bar by ${Math.round(bottom.gap)}px`);
  }
  await page.evaluate(() => { const m = document.querySelector('.main'); if (m) m.scrollTop = 0; });
}

let browser;
try {
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ARGS });
  for (const [label, viewport] of [['desktop', { width: 1600, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const mobile = label === 'mobile';
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, hasTouch: mobile, isMobile: mobile });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    const clearErrors = () => { errors.length = 0; };
    const assertNoErrors = (name) => {
      if (errors.length) bad(`${label} ${name}`, `console errors: ${errors.join(' | ')}`);
      else ok(`${label} ${name}`, 'no console errors');
    };
    const shot = async (name, wait = 550) => { await page.waitForTimeout(wait); await page.screenshot({ path: join(out, `discover-${label}-${name}.png`) }); };
    // The section tabs animate their scroll; wait until the scroll root has
    // stopped moving before pinning a section for a screenshot.
    const settleScroll = async () => {
      await page.evaluate(() => new Promise((resolve) => {
        const m = document.querySelector('.main');
        if (!m) return resolve();
        let last = m.scrollTop;
        let still = 0;
        const t0 = performance.now();
        const tick = () => {
          if (Math.abs(m.scrollTop - last) < 0.5) still += 1; else still = 0;
          last = m.scrollTop;
          if (still > 3 || performance.now() - t0 > 3000) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }));
    };
    // Pin a section to the top of the scroll area (smooth scrollIntoView from
    // the tab click can still be in flight when the screenshot is taken).
    const jumpTo = async (sel, block = 'start') => {
      await page.evaluate(([s, b]) => {
        const el = document.querySelector(s);
        if (el) el.scrollIntoView({ block: b, behavior: 'instant' });
      }, [sel, block]);
      await page.waitForTimeout(450);
    };

    // ---- People ---------------------------------------------------------
    await page.goto(`${BASE}/people?mock=1`);
    await page.waitForSelector('.pcard');
    await page.waitForTimeout(450);
    await shot('people');
    await audit(page, `${label} people`, { texts: ['People', 'Producers', 'Engineers', 'Musicians', 'Composers'], sels: ['.peoplegrid', '.pcard'] });
    if (mobile) {
      if ((await page.locator('.seg--tabs').count()) === 0) bad(`${label} people`, 'no mobile library tabs');
      const tabs = page.locator('.seg--tabs a');
      const names = await tabs.allInnerTexts();
      for (const t of ['People', 'Stats']) if (!names.includes(t)) bad(`${label} people`, `mobile library tabs missing ${t}`);
      const outside = await tabs.evaluateAll((els) => els.filter((e) => {
        const r = e.getBoundingClientRect();
        return r.right > window.innerWidth + 1 || r.left < -1;
      }).map((e) => e.textContent));
      if (outside.length) bad(`${label} people`, `mobile library tabs off-screen: ${outside.join(', ')}`);
      else ok(`${label} people`, `all ${names.length} library tabs visible on mobile (${names.join(', ')})`);
    }
    assertNoErrors('people');

    clearErrors();
    await page.locator('.pcard').first().click();
    await page.waitForSelector('.personhero__name');
    await page.waitForTimeout(650);
    await shot('person');
    await audit(page, `${label} person`, { texts: ['Credits'], sels: ['.personhero__name', '.pcredit', '.personhero__roles'] });
    if (mobile) {
      if (await page.locator('.page--person > .backlink').isVisible()) bad(`${label} person`, 'breadcrumb overlaps the mobile back button');
      else ok(`${label} person`, 'mobile back button replaces the breadcrumb');
    }
    assertNoErrors('person');

    // ---- Album: about/editions, credits, connections, your plays --------
    clearErrors();
    await page.goto(`${BASE}/albums?mock=1`);
    await page.waitForSelector('.vgrid .card__title');
    await page.locator('.vgrid .card__title', { hasText: 'Glass Harbour' }).first().click();
    await page.waitForSelector('.ahero__title');
    await page.locator('.atabs button', { hasText: 'About' }).click();
    await page.waitForSelector('.editions__table');
    await settleScroll();
    await jumpTo('#about');
    await shot('album-about');
    await audit(page, `${label} album about`, {
      texts: ['About', 'Originally released', 'Release type', 'Editions', 'This one', 'Other versions in your library'],
      sels: ['.editions__table', 'tr.is-this', '.facts', '.otherversions .card__title'],
    });
    assertNoErrors('album about');

    clearErrors();
    await page.locator('.atabs button', { hasText: 'Credits' }).click();
    await page.waitForSelector('#credits .person__name');
    await settleScroll();
    await jumpTo('#credits');
    await shot('album-credits');
    const hrefs = await page.locator('#credits .person__name').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
    if (!hrefs.every((h) => h.startsWith('/person/'))) bad(`${label} album credits`, `credits do not all link to /person: ${hrefs.slice(0, 3).join(', ')}`);
    else ok(`${label} album credits`, `${hrefs.length} credit links point at /person/…`);
    assertNoErrors('album credits');

    clearErrors();
    await page.waitForSelector('#connections .conn');
    await jumpTo('#connections');
    await shot('album-connections', 350);
    await audit(page, `${label} album connections`, { texts: ['Connections'], sels: ['#connections .conn', '#connections .conn__via a'] });
    assertNoErrors('album connections');

    clearErrors();
    await page.waitForSelector('.playstats .ptile__v');
    await jumpTo('.playstats', 'center');
    await shot('album-plays', 350);
    await audit(page, `${label} album plays`, { texts: ['Your plays', 'Plays', 'Listening time', 'First played', 'Last played'], sels: ['.playstats .ptile'] });
    assertNoErrors('album plays');

    // ---- Artist: discography with missing releases + bio photo ----------
    clearErrors();
    await page.locator('.ahero__meta a.link').first().click();
    await page.waitForSelector('.arthero__name');
    await page.waitForSelector('.discog');
    await page.waitForTimeout(650);
    await shot('artist');
    await audit(page, `${label} artist`, { texts: ['Albums', 'Your plays', 'Not in library'], sels: ['.discog__item', '.discog__item.is-missing', '.arthero__credit'] });
    await jumpTo('.discog');
    await shot('artist-discography', 350);
    assertNoErrors('artist');

    // ---- Stats ----------------------------------------------------------
    clearErrors();
    await page.goto(`${BASE}/stats?mock=1`);
    await page.waitForSelector('.stathero__v');
    await page.waitForTimeout(600);
    await shot('stats');
    await audit(page, `${label} stats`, {
      texts: ['Listening time', 'Plays', 'Albums', 'Artists', 'Listening over time', 'Listening by hour', 'Listening by weekday', 'Top albums', 'Top tracks', 'Top artists', 'Top genres', 'New discoveries', 'Lossless', 'Hi-res'],
      sels: ['.herogrid .stathero', '.spark', '.bar'],
    });
    await page.locator('.stats__period button', { hasText: '7 days' }).click();
    await page.waitForTimeout(500);
    const pressed = await page.locator('.stats__period button[aria-pressed="true"]').innerText();
    if (!pressed.includes('7 days')) bad(`${label} stats`, 'period switch did not select 7 days');
    await page.locator('.stats__period button', { hasText: 'All time' }).click();
    await page.waitForTimeout(400);
    await jumpTo('.statscols');
    await shot('stats-detail', 350);
    assertNoErrors('stats');

    // ---- Duplicates -----------------------------------------------------
    clearErrors();
    await page.goto(`${BASE}/duplicates?mock=1`);
    await page.waitForSelector('.dupegroup');
    await page.waitForTimeout(600);
    await shot('duplicates');
    await audit(page, `${label} duplicates`, {
      texts: ['Duplicates', 'Best pick', 'Recommended', 'Hide the others', 'Keep all'],
      sels: ['.dupegroup', '.dupever', '.dupever__folder', '.dupegroup__reason'],
    });
    const hide = page.locator('.dupegroup .btn--primary').first();
    if (await hide.isEnabled()) {
      await hide.click();
      await page.waitForSelector('.hiddenlist .hiddenrow');
      await page.waitForTimeout(500);
      await jumpTo('.hiddensec');
      await shot('duplicates-hidden', 300);
      const hiddenText = (await page.locator('.hiddensec').innerText()).toLowerCase();
      if (!hiddenText.includes('hidden albums') || !hiddenText.includes('unhide')) bad(`${label} duplicates`, 'hidden list did not appear');
      const before = await page.locator('.hiddenrow').count();
      await page.locator('.hiddenrow .btn', { hasText: 'Unhide' }).first().click();
      await page.waitForTimeout(600);
      const after = await page.locator('.hiddenrow').count();
      if (after >= before) bad(`${label} duplicates`, 'Unhide did not remove a hidden version');
      else ok(`${label} duplicates`, `hid ${before} versions, Unhide brought one back`);
    } else bad(`${label} duplicates`, '“Hide the others” was disabled');
    assertNoErrors('duplicates');

    // ---- Settings / server status --------------------------------------
    clearErrors();
    await page.goto(`${BASE}/settings?mock=1`);
    await page.waitForSelector('.statuscard');
    await page.waitForTimeout(500);
    await shot('settings');
    await audit(page, `${label} settings`, {
      texts: ['Settings', 'Server status', 'Library', 'Database', 'Playback', 'Background jobs', 'mpv', 'Spotify'],
      sels: ['.statusgrid .statuscard', '.statussummary', '.statusroot'],
    });
    assertNoErrors('settings');

    // ---- Library “more” menu routes (mobile has no TopBar) --------------
    clearErrors();
    await page.goto(`${BASE}/albums?mock=1`);
    await page.waitForSelector('.vgrid .card__title');
    await page.locator('[aria-label="More library actions"]').click();
    await page.waitForSelector('.menu [role="menuitem"]');
    await page.locator('.menu [role="menuitem"]', { hasText: 'Find duplicates…' }).click();
    await page.waitForURL('**/duplicates');
    await page.waitForSelector('.dupegroup');
    ok(`${label} nav`, 'Albums “more” menu opens Duplicates');
    await page.goto(`${BASE}/albums?mock=1`);
    await page.waitForSelector('.vgrid .card__title');
    await page.locator('[aria-label="More library actions"]').click();
    await page.locator('.menu [role="menuitem"]', { hasText: 'Server status…' }).click();
    await page.waitForURL('**/settings');
    await page.waitForSelector('.statuscard');
    ok(`${label} nav`, 'Albums “more” menu opens Server status');
    assertNoErrors('nav');

    await ctx.close();
  }
} catch (e) {
  bad('script', e?.stack ?? String(e));
} finally {
  await browser?.close();
  stop();
}

console.log('\n' + results.join('\n'));
if (failures.length) {
  console.error(`\n${failures.length} FAILURE(S)`);
  process.exitCode = 1;
} else {
  console.log('\nALL CHECKS PASSED');
}
