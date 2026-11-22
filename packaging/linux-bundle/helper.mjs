// Small jobs the shell scripts need without curl or wget (not every desktop has them): run by rune's own Node.
//   helper.mjs health URL            exit 0 when the rune server answers
//   helper.mjs needs-setup URL       prints yes / no
//   helper.mjs latest REPO           prints the newest release's version (tag without the leading v)
//   helper.mjs download URL FILE     saves URL to FILE
import { writeFile } from 'node:fs/promises';
const [cmd, a, b] = process.argv.slice(2);
const get = (u, ms = 15000) => fetch(u, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'rune-updater' } });
try {
  if (cmd === 'health') { const r = await get(`${a}/api/health`, 3000); process.exit(r.ok ? 0 : 1); }
  if (cmd === 'needs-setup') { const r = await get(`${a}/api/setup/status`, 5000); const j = await r.json(); console.log(j.needsSetup ? 'yes' : 'no'); process.exit(0); }
  if (cmd === 'latest') { const r = await get(`https://api.github.com/repos/${a}/releases/latest`); if (!r.ok) process.exit(1); const j = await r.json(); console.log(String(j.tag_name || '').replace(/^v/, '')); process.exit(0); }
  if (cmd === 'download') { const r = await get(a, 600000); if (!r.ok) throw new Error(`HTTP ${r.status}`); await writeFile(b, Buffer.from(await r.arrayBuffer())); process.exit(0); }
  console.error('unknown command'); process.exit(2);
} catch (e) { console.error(String(e?.message || e)); process.exit(1); }
