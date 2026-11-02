// Self-check for the playlist overlay (worker AA). Runs against a COPY of a rune
// database — never the live one. Usage:
//   npx tsx scripts/overlay-selfcheck.ts /tmp/dir/liner.db
//
// Adds three local tracks to the Spotify playlist named HORSE (top, position 10,
// end), prints the merged first 15 + last 3 entries, then simulates a Spotify
// resync that removes the song anchoring the middle entry and prints again.
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { openDb } from '../src/db/index.js';
import { addOverlayTracks, ensureOverlaySchema, mergedEntries } from '../src/myplaylists/overlay.js';
import { getPlaylistDetail } from '../src/myplaylists/index.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: npx tsx scripts/overlay-selfcheck.ts <copy-of-liner.db>');
  process.exit(2);
}
const live = resolve(homedir(), '.local/share/liner/liner.db');
if (resolve(path) === live) {
  console.error('refusing to write the live database; pass a .backup copy');
  process.exit(2);
}

const db = openDb(path);
ensureOverlaySchema(db);

const playlist = db
  .prepare("SELECT id, name, track_count FROM playlists WHERE name = 'HORSE' AND source = 'spotify'")
  .get() as { id: string; name: string; track_count: number } | undefined;
if (!playlist) {
  console.error('playlist HORSE not found in this database');
  process.exit(1);
}
const locals = db
  .prepare("SELECT id, title FROM tracks WHERE source = 'local' ORDER BY title LIMIT 3")
  .all() as { id: string; title: string }[];
if (locals.length < 3) {
  console.error(`need 3 local tracks, found ${locals.length}`);
  process.exit(1);
}

const id = playlist.id;
console.log(`playlist: ${playlist.name} (${playlist.id}), synced track_count=${playlist.track_count}`);
console.log(`local tracks: ${locals.map((t) => `${t.id} "${t.title}"`).join(', ')}`);

addOverlayTracks(db, id, [locals[0]!.id], 0);
addOverlayTracks(db, id, [locals[1]!.id], 10);
addOverlayTracks(db, id, [locals[2]!.id]); // append at the end

function dump(label: string): void {
  const detail = getPlaylistDetail(db, id);
  if (!detail) throw new Error('playlist vanished');
  const rows = mergedEntries(db, id);
  const format = (index: number): string => {
    const row = rows[index]!;
    const track = db.prepare('SELECT title FROM tracks WHERE id = ?').get(row.trackId) as
      | { title: string }
      | undefined;
    const mark = row.entrySource === 'rune-overlay' ? '* overlay' : '  spotify';
    return `${String(index).padStart(3)}. ${mark}  ${row.trackId}  ${track?.title ?? '(missing)'}  [${row.entryId}]`;
  };
  console.log(`\n== ${label} ==  trackCount=${detail.trackCount}, merged rows=${rows.length}`);
  console.log('-- first 15 --');
  for (let i = 0; i < Math.min(15, rows.length); i++) console.log(format(i));
  console.log('-- last 3 --');
  for (let i = Math.max(0, rows.length - 3); i < rows.length; i++) console.log(format(i));
}

dump('before resync');

// Simulate a Spotify resync removing the song that anchors the middle overlay: drop
// that occurrence from playlist_tracks and renumber positions like a refetch does.
const overlays = db
  .prepare('SELECT id, track_id, anchor_track_id, anchor_occurrence FROM playlist_overlay WHERE playlist_id = ? ORDER BY added_at, rowid')
  .all(id) as {
  id: string;
  track_id: string;
  anchor_track_id: string | null;
  anchor_occurrence: number;
}[];
const middle = overlays[1]!;
if (!middle.anchor_track_id) throw new Error('middle overlay has no anchor');
const anchorRows = db
  .prepare('SELECT rowid FROM playlist_tracks WHERE playlist_id = ? AND track_id = ? ORDER BY position')
  .all(id, middle.anchor_track_id) as { rowid: number }[];
const target = anchorRows[middle.anchor_occurrence];
if (!target) throw new Error('anchor occurrence not found');
db.prepare('DELETE FROM playlist_tracks WHERE rowid = ?').run(target.rowid);
const remaining = db
  .prepare('SELECT rowid FROM playlist_tracks WHERE playlist_id = ? ORDER BY position')
  .all(id) as { rowid: number }[];
const setPosition = db.prepare('UPDATE playlist_tracks SET position = ? WHERE rowid = ?');
remaining.forEach((row, index) => setPosition.run(index, row.rowid));
// A real sync also refreshes playlists.track_count.
db.prepare('UPDATE playlists SET track_count = ? WHERE id = ?').run(remaining.length, id);
console.log(
  `\n[resync] removed anchor ${middle.anchor_track_id} (occurrence ${middle.anchor_occurrence}); ${remaining.length} Spotify entries remain`,
);

dump('after resync (middle entry falls back)');
