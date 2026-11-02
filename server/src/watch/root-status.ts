// Mount/read-only/free-space status for library roots. Used by the watcher's
// status() and by the /health route. Read-only is detected from /proc/self/mounts
// (the NTFS watchdog remounts the drive read-only; access(W_OK) is not reliable
// for that, and lies for root). Free space comes from statfs.
import { readFileSync, statfsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LibraryRootStatus {
  path: string;
  mounted: boolean;
  /** True when the filesystem holding the root is mounted read-only. */
  readOnly: boolean;
  /** Free bytes available to this user (0 when not mounted / unknown). */
  free: number;
}

interface MountEntry {
  mountPoint: string;
  readOnly: boolean;
}

/** /proc/self/mounts escapes space, tab, newline and backslash as \ooo. */
function unescapeMount(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/** Linux mount table; empty on other platforms or when unreadable. */
function readMounts(): MountEntry[] {
  let text: string;
  try {
    text = readFileSync('/proc/self/mounts', 'utf8');
  } catch {
    return [];
  }
  const entries: MountEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const fields = line.split(' ');
    // device mountpoint fstype options dump pass
    if (fields.length < 4 || !fields[1]) continue;
    const options = fields[3]!.split(',');
    entries.push({ mountPoint: unescapeMount(fields[1]!), readOnly: options.includes('ro') });
  }
  return entries;
}

/** The longest mounted filesystem containing `path`. */
function mountFor(path: string, mounts: readonly MountEntry[]): MountEntry | undefined {
  let best: MountEntry | undefined;
  for (const m of mounts) {
    const hit =
      m.mountPoint === '/' ? path.startsWith('/') : path === m.mountPoint || path.startsWith(m.mountPoint + '/');
    if (hit && (!best || m.mountPoint.length > best.mountPoint.length)) best = m;
  }
  return best;
}

function freeBytes(path: string): number {
  try {
    const s = statfsSync(path);
    return Math.max(0, Number(s.bavail) * Number(s.bsize));
  } catch {
    return 0;
  }
}

/** Status for one root. Never throws: a vanished root is simply not mounted. */
export function rootStatus(path: string, mounts?: readonly MountEntry[]): LibraryRootStatus {
  const absolute = resolve(path);
  let mounted = false;
  try {
    mounted = statSync(absolute).isDirectory();
  } catch {
    mounted = false;
  }
  if (!mounted) return { path, mounted: false, readOnly: false, free: 0 };

  const mount = mountFor(absolute, mounts ?? readMounts());
  return {
    path,
    mounted: true,
    readOnly: mount?.readOnly ?? false,
    free: freeBytes(absolute),
  };
}

export function rootsStatus(roots: readonly string[]): LibraryRootStatus[] {
  // One /proc read per status call, shared by all roots.
  const mounts = readMounts();
  return roots.map((r) => rootStatus(r, mounts));
}
