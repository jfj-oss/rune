// Minimal CUE-sheet parser. The scanner only uses single-FILE cues (one huge
// audio file + virtual tracks); multi-FILE cues are parsed so they can be
// recognised and ignored, but their tracks are not used.

export interface CueTrack {
  /** FILE name as written in the cue sheet. */
  file: string;
  number: number;
  title?: string;
  performer?: string;
  /** INDEX 01 in milliseconds, relative to the FILE it belongs to. */
  index01Ms?: number;
  /** INDEX 00 (pregap) in milliseconds, when present. */
  index00Ms?: number;
}

export interface CueFile {
  name: string;
  tracks: CueTrack[];
}

export interface CueSheet {
  title?: string;
  performer?: string;
  /** REM DATE (or DATE / YEAR) verbatim. */
  date?: string;
  genre?: string;
  discNumber?: number;
  totalDiscs?: number;
  files: CueFile[];
  /** Every TRACK with an INDEX 01, in sheet order (across all FILEs). */
  tracks: CueTrack[];
}

/** Cue frames are 1/75 second. */
export function framesToMs(minutes: number, seconds: number, frames: number): number {
  return Math.round(((minutes * 60 + seconds) * 75 + frames) * (1000 / 75));
}

/** Decode a cue sheet: UTF-8 (BOM ok), falling back to windows-1252. */
export function decodeCue(buf: Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);

  // UTF-16 BOMs (rare, but cheap to support) must be checked before UTF-8.
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes).replace(/^﻿/, '');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes).replace(/^﻿/, '');
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    // Many old cue sheets are windows-1252 (e.g. Latin-1 accented artist names).
    return new TextDecoder('windows-1252').decode(bytes).replace(/^﻿/, '');
  }
}

function unquote(value: string): string {
  let v = value.trim();
  if (v.startsWith('"')) {
    // Strip the surrounding quotes, then unescape the common \" form.
    v = v.slice(1);
    if (v.endsWith('"')) v = v.slice(0, -1);
    v = v.replace(/\\"/g, '"');
  }
  return v.trim();
}

/** First token, e.g. "TRACK" from `TRACK 01 AUDIO`. */
function command(line: string): string {
  const m = line.match(/^([A-Za-z]+)\b/);
  return m ? m[1]!.toUpperCase() : '';
}

function parseFrames(value: string): number | undefined {
  const m = value.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})$/);
  if (!m) return undefined;
  return framesToMs(Number(m[1]), Number(m[2]), Number(m[3]));
}

/**
 * Parse cue-sheet text. Handles CRLF/CR line endings, quoted or bare values,
 * album-level vs per-track TITLE/PERFORMER, REM DATE/DISCNUMBER/GENRE and the
 * (common) case where INDEX 01 appears after the next FILE line.
 */
export function parseCue(text: string): CueSheet {
  const sheet: CueSheet = { files: [], tracks: [] };
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');

  let currentFile: string | undefined;
  let currentTrack: CueTrack | undefined;
  let trackFieldsOpen = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const cmd = command(line);
    if (!cmd) continue;

    if (cmd === 'REM') {
      const m = line.match(/^REM\s+([A-Za-z]+)\s+(.+)$/i);
      if (!m) continue;
      const key = m[1]!.toUpperCase();
      const value = unquote(m[2]!);
      if (key === 'DATE' || key === 'YEAR') sheet.date ??= value;
      else if (key === 'GENRE') sheet.genre ??= value;
      else if (key === 'DISCNUMBER') {
        const n = Number(value);
        if (Number.isFinite(n)) sheet.discNumber = n;
      } else if (key === 'TOTALDISCS') {
        const n = Number(value);
        if (Number.isFinite(n)) sheet.totalDiscs = n;
      }
      continue;
    }

    if (cmd === 'FILE') {
      // FILE "name.ext" WAVE  (or an unquoted name)
      const m = line.match(/^FILE\s+(?:"([^"]*)"|(\S+))/i);
      if (!m) continue;
      currentFile = (m[1] ?? m[2] ?? '').trim();
      const fileEntry: CueFile = { name: currentFile, tracks: [] };
      sheet.files.push(fileEntry);
      // Keep currentTrack so a following INDEX 01 attaches to the new FILE,
      // but no further TITLE/PERFORMER lines belong to it.
      trackFieldsOpen = false;
      continue;
    }

    if (cmd === 'TRACK') {
      const m = line.match(/^TRACK\s+(\d+)\s+(\w+)/i);
      if (!m) continue;
      const number = Number(m[1]);
      const isAudio = m[2]!.toUpperCase() === 'AUDIO';
      currentTrack = {
        file: currentFile ?? '',
        number,
        ...(isAudio ? {} : {}),
      };
      trackFieldsOpen = true;
      // Non-audio tracks are ignored for playback; keep parsing for robustness
      // but only expose audio ones later.
      if (!isAudio) currentTrack = undefined;
      continue;
    }

    if (cmd === 'TITLE' || cmd === 'PERFORMER') {
      const m = line.match(/^(TITLE|PERFORMER)\s+(.+)$/i);
      if (!m) continue;
      const value = unquote(m[2]!);
      if (!value) continue;
      if (currentTrack && trackFieldsOpen) {
        if (m[1]!.toUpperCase() === 'TITLE') currentTrack.title = value;
        else currentTrack.performer = value;
      } else {
        if (m[1]!.toUpperCase() === 'TITLE') sheet.title ??= value;
        else sheet.performer ??= value;
      }
      continue;
    }

    if (cmd === 'INDEX') {
      const m = line.match(/^INDEX\s+(\d{1,2})\s+(\S+)/i);
      if (!m || !currentTrack) continue;
      const indexNo = Number(m[1]);
      const ms = parseFrames(m[2]!);
      if (ms === undefined) continue;
      if (indexNo === 0) {
        currentTrack.index00Ms = ms;
      } else if (indexNo === 1) {
        currentTrack.index01Ms = ms;
        // In EAC-style sheets the INDEX 01 may follow the next FILE line;
        // the track always belongs to the most recent FILE.
        if (currentFile) currentTrack.file = currentFile;
        sheet.tracks.push(currentTrack);
      }
      continue;
    }
  }

  // Rebuild per-file track lists now that track.file is final.
  for (const file of sheet.files) file.tracks = [];
  for (const track of sheet.tracks) {
    let file = sheet.files.find((f) => f.name === track.file);
    if (!file && sheet.files.length === 1) {
      file = sheet.files[0]!;
      track.file = file.name;
    }
    if (file) file.tracks.push(track);
  }

  return sheet;
}
