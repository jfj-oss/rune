// Live end-to-end self-check for the meta module.
//
//   pnpm -C server exec tsx scripts/meta-live.ts
//
// It scans the *real* library (read-only) into a throwaway database, prunes the
// database to the ten albums below, runs the real matcher (shared MusicBrainz
// rate limiter, no cover downloads), then fetches real album details. The
// library is never written to; dataDir and the database are temp files.
//
// Nothing here prints the Genius token from server/config.json.
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import { createScanner } from '../src/scan/index.js';
import { createMatcher } from '../src/match/index.js';
import { MbClient, RateLimiter, artistCreditName } from '../src/match/mb.js';
import { createMeta } from '../src/meta/index.js';
import { namesMatch, normalizeTitle, titleSimilarity } from '../src/meta/text.js';
import type { AlbumDetails } from '@liner/shared';

const LIBRARY = process.env.LINER_LIBRARY ?? '/path/to/Music';
const USER_AGENT = 'Liner/0.1 ( personal music player, self-hosted )';

interface Target {
  artist: string;
  title: string;
  year: number;
}

// The ten albums requested for the round-2 self-check.
const targets: Target[] = [
  { artist: 'Alice In Chains', title: 'Jar Of Flies', year: 1994 },
  { artist: 'Bill Withers', title: 'Still Bill', year: 1972 },
  { artist: 'Bob Marley & The Wailers', title: 'Uprising', year: 1980 },
  { artist: 'Blue Öyster Cult', title: 'Fire of Unknown Origin', year: 1981 },
  { artist: 'Daft Punk', title: 'Discovery', year: 2001 },
  { artist: 'Gerry Rafferty', title: 'City to City', year: 1978 },
  { artist: 'Kanye West', title: 'Yeezus', year: 2013 },
  { artist: 'Billy Talent', title: 'Billy Talent II', year: 2006 },
  { artist: 'a-ha', title: 'Hunting High And Low', year: 1985 },
  { artist: 'Air', title: 'Moon Safari', year: 1998 },
];

interface AlbumRow {
  id: string;
  title: string;
  year: number | null;
  artist_name: string;
}

interface MatchedRow extends AlbumRow {
  mb_release_id: string | null;
  mb_release_group_id: string | null;
  match_confidence: number | null;
}

interface Selected {
  target: Target;
  row: AlbumRow | null;
  alternatives: AlbumRow[];
}

const WIKI_MARKUP = /\{\{|\[\[|<ref\b|&nbsp;|'''/;
const OK_SCALES = new Set([4, 5, 10, 100]);

function chooseLocal(all: AlbumRow[], target: Target): Selected {
  const artistMatches = all.filter((row) => namesMatch(target.artist, row.artist_name));
  const wanted = normalizeTitle(target.title);
  const exact = artistMatches.filter((row) => normalizeTitle(row.title) === wanted);
  let candidates = exact;
  if (!candidates.length) candidates = artistMatches.filter((row) => titleSimilarity(target.title, row.title) >= 0.85);
  if (!candidates.length) candidates = artistMatches.filter((row) => titleSimilarity(target.title, row.title) >= 0.5);
  if (!candidates.length) candidates = all.filter((row) => normalizeTitle(row.title) === wanted);

  const ranked = [...candidates].sort((a, b) => {
    const aExact = normalizeTitle(a.title) === wanted ? 1 : 0;
    const bExact = normalizeTitle(b.title) === wanted ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    const aYear = a.year == null ? 9999 : Math.abs(a.year - target.year);
    const bYear = b.year == null ? 9999 : Math.abs(b.year - target.year);
    if (aYear !== bYear) return aYear - bYear;
    return titleSimilarity(target.title, b.title) - titleSimilarity(target.title, a.title);
  });
  const row = ranked[0] ?? null;
  return { target, row, alternatives: row ? ranked.slice(1) : [] };
}

function maxCacheRowid(db: Db): number {
  const row = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM http_cache').get() as { n: number };
  return row.n;
}

/** The article title of the Wikipedia parse response fetched for this album. */
function wikipediaArticleSince(db: Db, since: number): string | null {
  const rows = db
    .prepare(
      `SELECT key, body FROM http_cache
        WHERE rowid > ? AND key LIKE 'https://en.wikipedia.org/w/api.php?action=parse%'
        ORDER BY rowid`,
    )
    .all(since) as { key: string; body: string }[];
  let title: string | null = null;
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.body) as { parse?: { title?: string } };
      if (parsed.parse?.title) title = parsed.parse.title;
    } catch {
      // ignore malformed cache entries
    }
  }
  return title;
}

function markupIssues(details: AlbumDetails | null, article: string | null): string[] {
  const issues: string[] = [];
  const check = (label: string, value: string | undefined): void => {
    if (value && WIKI_MARKUP.test(value)) issues.push(`${label} contains wiki markup`);
  };
  if (!details) return issues;
  check('reception', details.reception?.value);
  check('background', details.background?.value);
  for (const score of details.scores) check(`score outlet "${score.outlet}"`, score.outlet);
  for (const quote of details.quotes) {
    check(`quote outlet "${quote.outlet}"`, quote.outlet);
    check(`quote (${quote.outlet})`, quote.quote);
  }
  for (const note of details.artistNotes) check(`genius note (${note.url})`, note.value);
  if (article && WIKI_MARKUP.test(article)) issues.push('article title contains wiki markup');

  for (const score of details.scores) {
    if (!Number.isFinite(score.score) || !Number.isFinite(score.scale) || score.scale <= 0) {
      issues.push(`${score.outlet}: invalid scale ${score.score}/${score.scale}`);
    } else if (score.score < 0 || score.score > score.scale) {
      issues.push(`${score.outlet}: score ${score.score} out of ${score.scale}`);
    } else if (!OK_SCALES.has(score.scale)) {
      issues.push(`${score.outlet}: unexpected scale ${score.scale}`);
    }
  }
  const allMusic = details.scores.find((score) => score.outlet === 'AllMusic');
  if (allMusic && allMusic.scale !== 5) issues.push(`AllMusic scale ${allMusic.scale} (expected 5)`);
  return issues;
}

async function main(): Promise<void> {
  // Read server/config.json directly instead of loadConfig(): loadConfig()
  // creates the real dataDir, and this script must only touch temp directories.
  const configFile = new URL('../config.json', import.meta.url);
  const userConfig = existsSync(configFile)
    ? (JSON.parse(readFileSync(configFile, 'utf8')) as { userAgent?: unknown; geniusToken?: unknown })
    : {};
  const workDir = mkdtempSync(join(tmpdir(), 'liner-meta-live-'));
  const dataDir = join(workDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const cfg: Config & { geniusToken?: string } = {
    libraryRoots: [LIBRARY],
    dataDir,
    port: 0,
    audioDevice: 'pipewire',
    userAgent: typeof userConfig.userAgent === 'string' ? userConfig.userAgent : USER_AGENT,
    ...(typeof userConfig.geniusToken === 'string' ? { geniusToken: userConfig.geniusToken } : {}),
  };
  const db = openDb(join(workDir, 'live.db'));

  console.log('Liner meta live self-check');
  console.log(`library: ${LIBRARY} (read-only)`);
  console.log(`temp dir: ${workDir}`);
  console.log(`genius token: ${cfg.geniusToken ? 'configured' : 'NOT configured'}\n`);

  try {
    // ---------- 1. real scan ----------
    console.log('=== scanning real library');
    const scanner = createScanner(db, cfg);
    let lastLog = Date.now();
    const stats = await scanner.scan((progress) => {
      const now = Date.now();
      if (now - lastLog >= 10_000) {
        console.log(
          `  scanning: ${progress.filesSeen} files, ${progress.albumsFound} albums, ${progress.errors} errors`,
        );
        lastLog = now;
      }
    });
    console.log(
      `scan done: files=${stats.filesSeen} albums=${stats.albumsFound} changedFiles=${stats.changedFiles} ` +
        `errors=${stats.errors} elapsed=${(stats.elapsedMs / 1000).toFixed(1)}s`,
    );

    // ---------- 2. pick the ten albums and prune everything else ----------
    const all = db
      .prepare(
        `SELECT a.id, a.title, a.year, ar.name AS artist_name
           FROM albums a JOIN artists ar ON ar.id = a.artist_id
          ORDER BY ar.name, a.year, a.title`,
      )
      .all() as AlbumRow[];
    const selected = targets.map((target) => chooseLocal(all, target));

    console.log('\n=== local albums');
    for (const item of selected) {
      const row = item.row;
      if (!row) {
        console.log(`  MISSING  ${item.target.artist} — ${item.target.title} (${item.target.year})`);
        continue;
      }
      const others = item.alternatives.length ? ` (+${item.alternatives.length} other copy/copies)` : '';
      console.log(
        `  found    ${item.target.artist} — ${item.target.title}: local "${row.title}" — ${row.artist_name}` +
          ` (${row.year ?? 'year?'}) [${row.id}]${others}`,
      );
    }

    const ids = selected.filter((item) => item.row).map((item) => item.row!.id);
    if (ids.length === 0) throw new Error('none of the target albums were found in the scan');
    db.prepare(`DELETE FROM albums WHERE id NOT IN (${ids.map(() => '?').join(',')})`).run(...ids);
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM albums').get() as { n: number };
    console.log(`\npruned temp db to ${remaining.n} album(s); matcher and meta only see these`);

    // ---------- 3. real matcher (shared 1 req/s MusicBrainz limiter) ----------
    const limiter = new RateLimiter(1000);
    const matcher = createMatcher(db, cfg, { limiter, downloadCovers: false });
    console.log('\n=== matching with MusicBrainz');
    await matcher.matchPending((done, total) => {
      if (done === 0) return;
      console.log(`  processed ${done}/${total}`);
    });
    const matchedCount = db
      .prepare('SELECT COUNT(*) AS n FROM albums WHERE mb_release_id IS NOT NULL')
      .get() as { n: number };
    console.log(`matched ${matchedCount.n}/${ids.length} releases with confidence >= 0.6`);

    // ---------- 4. real details ----------
    const mbInfo = new MbClient({ userAgent: cfg.userAgent, db, limiter });
    const meta = createMeta(db, cfg, {
      mbLimiter: limiter,
      mbRateLimitMs: 1000,
      geniusMaxTracks: 12,
      geniusMaxNotes: 20,
    });

    console.log('\n=== album details');
    let receptionCount = 0;
    let scores3Count = 0;
    let quoteCount = 0;
    let geniusCount = 0;
    let articleCount = 0;
    let issueCount = 0;

    const started = Date.now();
    for (const item of selected) {
      const target = item.target;
      console.log(`\n${target.artist} — ${target.title} (${target.year})`);
      if (!item.row) {
        console.log('  skipped: not in the scanned library');
        continue;
      }

      const row = db
        .prepare(
          `SELECT a.id, a.title, a.year, ar.name AS artist_name, a.mb_release_id,
                  a.mb_release_group_id, a.match_confidence
             FROM albums a JOIN artists ar ON ar.id = a.artist_id
            WHERE a.id = ?`,
        )
        .get(item.row.id) as MatchedRow | undefined;
      if (!row) {
        console.log('  skipped: album row vanished');
        continue;
      }

      let releaseTitle = '(none)';
      if (row.mb_release_id) {
        try {
          const release = await mbInfo.getRelease(row.mb_release_id);
          releaseTitle = `${release.title} — ${artistCreditName(release['artist-credit'])}`;
        } catch {
          releaseTitle = '(release lookup failed)';
        }
      }
      console.log(
        `  matched release: ${releaseTitle}${row.mb_release_id ? ` [${row.mb_release_id}]` : ''}` +
          `  confidence: ${row.match_confidence ?? '—'}` +
          `  release group: ${row.mb_release_group_id ?? '—'}`,
      );

      const since = maxCacheRowid(db);
      const t0 = Date.now();
      const details = await meta.getDetails(row.id);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const article = wikipediaArticleSince(db, since);
      if (article) articleCount++;

      console.log(`  wikipedia: ${article ?? '(none)'}`);
      console.log(
        `  reception: ${
          details?.reception
            ? `${details.reception.value.length} chars — ${details.reception.value.slice(0, 200)}`
            : '(none)'
        }`,
      );
      console.log(
        `  scores: ${
          details && details.scores.length
            ? details.scores.map((score) => `${score.outlet} ${score.score}/${score.scale}`).join('; ')
            : '(none)'
        }`,
      );
      if (details?.quotes.length) {
        for (const quote of details.quotes) {
          console.log(
            `  quote: ${quote.outlet}${quote.author ? ` (${quote.author})` : ''}: ${quote.quote.slice(0, 80)}`,
          );
        }
      } else {
        console.log('  quotes: (none)');
      }
      console.log(
        `  background: ${
          details?.background
            ? `${details.background.value.length} chars — ${details.background.value.slice(0, 120)}`
            : '(none)'
        }`,
      );
      const notes = details?.artistNotes ?? [];
      console.log(
        `  genius: ${notes.length} notes, verified ${notes.filter((note) => note.verifiedArtist).length}` +
          (notes[0] ? ` — first: ${notes[0].value.slice(0, 100)}` : ''),
      );

      const issues = markupIssues(details, article);
      issueCount += issues.length;
      console.log(`  checks: ${issues.length ? issues.join(' | ') : 'clean'} (fetched in ${elapsed}s)`);

      if (details?.reception) receptionCount++;
      if ((details?.scores.length ?? 0) >= 3) scores3Count++;
      if ((details?.quotes.length ?? 0) >= 1) quoteCount++;
      if (notes.length >= 1) geniusCount++;
    }

    // ---------- 5. summary against the round-2 targets ----------
    console.log('\n=== targets ===');
    const checks: [string, number, number][] = [
      ['reception prose', receptionCount, 8],
      ['at least 3 scores', scores3Count, 7],
      ['at least 1 quote', quoteCount, 6],
      ['Genius notes', geniusCount, 6],
    ];
    for (const [label, value, target] of checks) {
      console.log(`  ${label}: ${value}/10 ${value >= target ? 'PASS' : 'MISS'} (target ${target}/10)`);
    }
    console.log(`  wikipedia article found: ${articleCount}/10`);
    console.log(`  markup/invalid-scale issues: ${issueCount}`);
    console.log(`  details+match elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`\ntemp db: ${join(workDir, 'live.db')}`);
    console.log(`temp dataDir: ${dataDir}`);

    if (issueCount > 0) process.exitCode = 1;
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
