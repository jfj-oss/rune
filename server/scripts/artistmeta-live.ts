// Live self-check for artist metadata. Network is allowed here only.
//
// Run: pnpm -C server exec tsx scripts/artistmeta-live.ts
//
// The real library DB is copied (including its WAL/SHM) into a temp directory
// before use; the original is never opened for writing. Images are saved under
// the configured dataDir (<dataDir>/artists), exactly as in production.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ids, type Db } from '../src/db/index.js';
import { loadConfig, type Config } from '../src/config.js';
import { createArtistMeta, type ArtistInfo } from '../src/meta/artist.js';

const REAL_DB = join(homedir(), '.local/share/liner/liner.db');

const NAMED = ['Alice in Chains', 'Daft Punk', 'Bill Withers', 'Blue Öyster Cult'];
const MORE = ['Radiohead', 'Jeff Buckley', 'The Beatles', 'Kendrick Lamar', 'Elton John'];
const OBSCURE = 'Xzzyq Fnord Trio';

const WIKI_MARKUP = /\[\[|\]\]|\{\{|\}\}|<ref|<[a-z/][^>]*>|\{\||&amp;|&lt;|&gt;|'''/i;

interface SourceRow {
  id: string;
  name: string;
  mbid: string | null;
}

function copyRealDb(): { path: string; dir: string } {
  if (!existsSync(REAL_DB)) throw new Error(`real library db not found: ${REAL_DB}`);
  const dir = mkdtempSync(join(tmpdir(), 'liner-artistmeta-live-'));
  const path = join(dir, 'liner.db');
  copyFileSync(REAL_DB, path);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(REAL_DB + suffix)) copyFileSync(REAL_DB + suffix, path + suffix);
  }
  return { path, dir };
}

function findArtist(db: Db, name: string): SourceRow | null {
  const row = db
    .prepare(
      `SELECT id, name, mbid FROM artists WHERE lower(name) = lower(?) ORDER BY mbid IS NULL, id LIMIT 1`,
    )
    .get(name) as SourceRow | undefined;
  return row ?? null;
}

function ffprobeDimensions(path: string): string {
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', path],
      { encoding: 'utf8', timeout: 15_000 },
    ).trim();
    return out || 'unknown';
  } catch {
    return 'unknown';
  }
}

function first150(text: string): string {
  return text.length > 150 ? `${text.slice(0, 150)}…` : text;
}

function describe(info: ArtistInfo): string[] {
  const lines: string[] = [];
  if (info.bio) {
    lines.push(`  bio (${info.bio.value.length} chars, ${info.bio.source}): "${first150(info.bio.value)}"`);
    lines.push(`  bio url: ${info.bio.url}`);
    const markup = WIKI_MARKUP.exec(info.bio.value);
    lines.push(`  wiki markup: ${markup ? `FOUND ${JSON.stringify(markup[0])}` : 'none'}`);
  } else {
    lines.push('  bio: none');
  }

  if (info.imagePath && existsSync(info.imagePath)) {
    const size = statSync(info.imagePath).size;
    lines.push(
      `  image: ${info.imagePath} (${(size / 1024).toFixed(1)} KB, ${ffprobeDimensions(info.imagePath)})`,
    );
  } else {
    lines.push('  image: none');
  }

  if (info.imageCredit) {
    const credit = info.imageCredit;
    lines.push(
      `  credit: ${credit.author ?? '(no author)'} — ${credit.license ?? '(no licence)'} — ${credit.url}`,
    );
  } else {
    lines.push('  credit: none');
  }
  return lines;
}

async function main(): Promise<void> {
  const cfg: Config = loadConfig();
  const copy = copyRealDb();
  const db = openDb(copy.path);
  const artistMeta = createArtistMeta(db, cfg);
  console.log(`real db (copied, original untouched): ${REAL_DB}`);
  console.log(`working copy: ${copy.path}`);
  console.log(`image dir: ${join(cfg.dataDir, 'artists')}\n`);

  const targets: { name: string; row: SourceRow; expect: 'bio' | 'none' }[] = [];
  let failures = 0;

  try {
    for (const name of NAMED) {
      const row = findArtist(db, name);
      if (!row) {
        console.log(`!! ${name}: not present in the real library db`);
        failures++;
        continue;
      }
      targets.push({ name, row, expect: 'bio' });
    }

    // Obscure name: insert into the throwaway copy so the "nothing found" path
    // runs against the same database/schema.
    const obscureId = ids.artistByName(OBSCURE);
    db.prepare('INSERT OR REPLACE INTO artists (id, name) VALUES (?, ?)').run(obscureId, OBSCURE);
    targets.push({ name: OBSCURE, row: { id: obscureId, name: OBSCURE, mbid: null }, expect: 'none' });

    for (const name of MORE) {
      const row = findArtist(db, name);
      if (!row) {
        console.log(`!! ${name}: not present in the real library db`);
        failures++;
        continue;
      }
      targets.push({ name, row, expect: 'bio' });
    }

    for (const target of targets) {
      console.log(`=== ${target.name}  [${target.row.id}]${target.row.mbid ? '' : '  (no mbid → Wikipedia fallback)'}`);
      const started = Date.now();
      const info = await artistMeta.getArtistInfo(target.row.id, { refresh: true });
      if (!info) {
        console.log('  !! artist id not found');
        failures++;
        continue;
      }
      for (const line of describe(info)) console.log(line);
      console.log(`  resolved in ${((Date.now() - started) / 1000).toFixed(1)}s`);

      const hasBio = Boolean(info.bio?.value);
      if (target.expect === 'bio' && !hasBio) {
        console.log('  !! expected a bio');
        failures++;
      }
      if (target.expect === 'none' && (hasBio || info.imagePath)) {
        console.log('  !! expected no bio/image');
        failures++;
      }
      if (info.bio && WIKI_MARKUP.test(info.bio.value)) {
        console.log('  !! bio contains wiki markup');
        failures++;
      }
      console.log('');
    }

    const stored = db.prepare('SELECT count(*) AS n FROM artist_info').get() as { n: number };
    const found = db.prepare('SELECT count(*) AS n FROM artist_info WHERE found = 1').get() as { n: number };
    console.log(`artist_info rows: ${stored.n} (found ${found.n}, empty ${stored.n - found.n})`);
    const files = existsSync(join(cfg.dataDir, 'artists')) ? readdirSync(join(cfg.dataDir, 'artists')).length : 0;
    console.log(`cached image files in ${join(cfg.dataDir, 'artists')}: ${files}`);
    console.log(`failures: ${failures}`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    db.close();
    rmSync(copy.dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
