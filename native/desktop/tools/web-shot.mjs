// The web UI in headless Chromium (GPU: ANGLE/Vulkan, never SwiftShader) against OUR temp server only.
//   node web-shot.mjs <base-url> <route> <W> <H> <out.png> [js to run before the shot] [wait-ms]
// The base URL must be 127.0.0.1 and not port 4545.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../../../server/package.json'));
const { chromium } = require('playwright-core');
const [base, route, W, H, out, pre = '', wait = '1800'] = process.argv.slice(2);
const u = new URL(base);
if (u.hostname !== '127.0.0.1' || u.port === '4545' || !u.port) { console.error('refusing', base); process.exit(2); }
const sep = route.includes('?') ? '&' : '?';
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium', headless: true,
  args: ['--headless=new', '--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu', '--password-store=basic', '--use-mock-keychain', '--mute-audio', '--disable-audio-output'],
});
const page = await browser.newPage({ viewport: { width: +W, height: +H }, deviceScaleFactor: 1 });
await page.goto(`${base}${route}${sep}ambient=off`, { waitUntil: 'networkidle' });
await page.waitForTimeout(+wait);
if (pre) { await page.evaluate(pre); await page.waitForTimeout(900); }
await page.screenshot({ path: out });
await browser.close();
