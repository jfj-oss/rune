// Self-check for the people routes against a COPY of the real library db.
//
// Run: pnpm -C server exec tsx scripts/people-selfcheck.ts
//
// The original DB is only read by SQLite's `.backup`; every query below runs on
// a temp copy. MusicBrainz lookups are disabled (offline check); the MB relation
// path is covered by tests/fixtures/people in the unit suite.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { openDb, type Db } from '../src/db/index.js';
import {
  registerPeopleRoutes,
  type AlbumConnections,
  type PersonPage,
  type PersonSummary,
} from '../src/people/index.js';

const srcPath = process.argv[2] ?? join(homedir(), '.local/share/liner/liner.db');
const tmp = mkdtempSync(join(tmpdir(), 'liner-people-'));
const copy = join(tmp, 'liner.db');

// sqlite3's backup API copies a live db (including WAL contents) consistently.
execFileSync('sqlite3', [srcPath, `.backup '${copy.replace(/'/g, "''")}'`], { stdio: 'inherit' });
console.log(`source (read-only): ${srcPath}`);
console.log(`temp copy:          ${copy}`);

const db = openDb(copy);
const app = Fastify({ logger: false });
registerPeopleRoutes(app, db, { enabled: false });
await app.ready();

async function get<T>(url: string): Promise<T> {
  const res = await app.inject({ method: 'GET', url });
  if (res.statusCode !== 200) throw new Error(`${url} → ${res.statusCode} ${res.body}`);
  return res.json() as T;
}

const counts = db
  .prepare(
    `SELECT (SELECT count(*) FROM credits) AS credits,
            (SELECT count(DISTINCT artist_id) FROM credits) AS people,
            (SELECT count(*) FROM albums) AS albums`,
  )
  .get() as { credits: number; people: number; albums: number };
console.log(`credits: ${counts.credits}, credited people: ${counts.people}, albums: ${counts.albums}`);

// ---------- 1. top 15 most-credited people with role breakdown ----------

const everyone = await get<PersonSummary[]>('/people');
console.log('\n=== Top 15 most-credited people ===');
for (const [index, person] of everyone.slice(0, 15).entries()) {
  const page = await get<PersonPage>(`/people/${encodeURIComponent(person.id)}`);
  const roles = page.roles.map((r) => `${r.role}×${r.count}`).join(', ');
  console.log(`${String(index + 1).padStart(2)}. ${person.name} — ${person.albumCount} albums — ${roles}  [${person.id}]`);
}

// ---------- 2. full page data for one producer ----------

const producers = await get<PersonSummary[]>('/people?role=Producer');
const producer = producers[0];
if (!producer) throw new Error('no producers in the library');
const producerPage = await get<PersonPage>(`/people/${encodeURIComponent(producer.id)}`);
console.log(`\n=== Full page: ${producer.name} (Producer #1, id ${producer.id}) ===`);
console.log(JSON.stringify(producerPage, null, 2));

// ---------- 3. connections for three albums ----------

const busiest = db
  .prepare(
    `SELECT c.album_id AS id, a.title AS title, ar.name AS artist, a.year AS year, count(*) AS n
     FROM credits c JOIN albums a ON a.id = c.album_id LEFT JOIN artists ar ON ar.id = a.artist_id
     GROUP BY c.album_id ORDER BY n DESC, a.title LIMIT 3`,
  )
  .all() as { id: string; title: string; artist: string | null; year: number | null; n: number }[];

console.log('\n=== Album connections (three most-credited albums) ===');
for (const album of busiest) {
  const body = await get<AlbumConnections>(`/albums/${encodeURIComponent(album.id)}/connections`);
  const ids = body.connections.map((c) => c.album.id);
  const unique = new Set(ids).size === ids.length;
  console.log(
    `\n${album.year ?? '----'} ${album.artist ?? '?'} — ${album.title} (${album.n} credit rows)` +
      ` → ${body.connections.length} connected albums, unique=${unique}`,
  );
  for (const connection of body.connections.slice(0, 8)) {
    const who = connection.people
      .map((p) => `${p.artist.name} (${p.roles.join('/')})`)
      .join(', ');
    console.log(
      `  - ${connection.album.year ?? '----'} ${connection.album.artist.name} — ${connection.album.title}: ${who}`,
    );
  }
  if (body.connections.length > 8) console.log(`  … ${body.connections.length - 8} more`);
  if (!unique) console.log('  !! duplicate album ids in connections');
}

// ---------- 4. duplicate-person check ----------

console.log('\n=== Duplicate / merge check ===');

const provisional = db
  .prepare(
    `SELECT count(*) AS n FROM credits c JOIN artists ar ON ar.id = c.artist_id
     WHERE ar.id LIKE 'ar:n:%'`,
  )
  .get() as { n: number };
console.log(`provisional ar:n: ids in credits: ${provisional.n} (expected 0)`);

const sameName = db
  .prepare(
    `SELECT lower(trim(ar.name)) AS name, count(*) AS n,
            group_concat(ar.id || ' [' || ar.name || ']', ' | ') AS ids
     FROM artists ar
     WHERE ar.id IN (SELECT artist_id FROM credits)
     GROUP BY lower(trim(ar.name))
     HAVING n > 1
     ORDER BY n DESC, name`,
  )
  .all() as { name: string; n: number; ids: string }[];
if (sameName.length === 0) {
  console.log('no credited people share a name — no suspected duplicate ids');
} else {
  console.log(`${sameName.length} name collision(s) among credited people (same name ≠ same person; check MBIDs):`);
  for (const row of sameName.slice(0, 20)) console.log(`  - ${row.ids}`);
}

// Same-person-under-two-ids is only detectable by name here: an `ar:n:` row and
// an `ar:<uuid>` row with the same normalized name would be the serious case.
const provisionalVsMbid = db
  .prepare(
    `SELECT a1.id AS provisional, a1.name AS name, a2.id AS canonical
     FROM artists a1
     JOIN artists a2 ON lower(trim(a1.name)) = lower(trim(a2.name)) AND a2.id LIKE 'ar:%' AND a2.id NOT LIKE 'ar:n:%'
     WHERE a1.id LIKE 'ar:n:%'
       AND (a1.id IN (SELECT artist_id FROM credits) OR a2.id IN (SELECT artist_id FROM credits))`,
  )
  .all() as { provisional: string; name: string; canonical: string }[];
if (provisionalVsMbid.length === 0) {
  console.log('no provisional ar:n: person shadows a MusicBrainz person');
} else {
  console.log('provisional ids shadowing MusicBrainz ids (proposed merge: repoint credits/track_artists/albums to the ar:<uuid> row):');
  for (const row of provisionalVsMbid) console.log(`  - ${row.name}: ${row.provisional} → ${row.canonical}`);
}

// Invariants on the sampled pages.
const problems: string[] = [];
for (const person of everyone.slice(0, 40)) {
  const page = await get<PersonPage>(`/people/${encodeURIComponent(person.id)}`);
  const creditIds = page.credits.map((c) => c.album.id);
  if (new Set(creditIds).size !== creditIds.length) problems.push(`${person.name}: duplicate album in credits`);
  const asArtistIds = page.asArtist.map((a) => a.id);
  if (new Set(asArtistIds).size !== asArtistIds.length) problems.push(`${person.name}: duplicate asArtist album`);
  const collaboratorIds = page.collaborators.map((c) => c.artist.id);
  if (new Set(collaboratorIds).size !== collaboratorIds.length) problems.push(`${person.name}: duplicate collaborator`);
  if (page.collaborators.length > 12) problems.push(`${person.name}: >12 collaborators`);
  if (page.id !== person.id) problems.push(`${person.name}: page id mismatch`);
}
console.log(problems.length === 0 ? 'page invariants: PASS (40 people)' : `page invariants: FAIL\n${problems.join('\n')}`);

await app.close();
db.close();
rmSync(tmp, { recursive: true, force: true });
