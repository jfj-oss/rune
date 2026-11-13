// Does a request come from a browser on the very machine rune runs on?
//
// The page asks because of the "Linux PC speakers" zone: a tab on that PC needs no player of its own (the pc zone IS
// its speakers), and a second player there (the Web Playback SDK in the tab) is a second Spotify Connect device
// competing with Soloist for the one stream an account has.
import { networkInterfaces } from 'node:os';

const clean = (ip: string): string => ip.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '').replace(/%.*$/, '');
const isLoopback = (ip: string): boolean => ip === '::1' || /^127\./.test(ip);

/** Every address of this machine's own interfaces (loopback included). */
export function ownAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) out.push(clean(a.address));
  return out;
}

/**
 * `remote` is the socket's peer. A reverse proxy on this machine (tailscale serve) connects from the loopback and names
 * the real client in X-Forwarded-For; that header is only believed from a peer on this machine, since anyone else could
 * write it. The client counts as this machine when every address named is a loopback or one of our own. Without the
 * header, only a request addressed to the loopback itself (http://localhost:…) counts: a proxy that names no client
 * could be passing on anyone, and "elsewhere" is the safe answer (the page then keeps its own player).
 */
export function fromThisMachine(req: { remote: string | undefined; forwardedFor?: string | string[]; host?: string }, own: string[] = ownAddresses()): boolean {
  if (!req.remote) return false;
  const mine = (ip: string): boolean => isLoopback(ip) || own.includes(ip);
  if (!mine(clean(req.remote))) return false;
  const header = Array.isArray(req.forwardedFor) ? req.forwardedFor.join(',') : req.forwardedFor ?? '';
  const hops = header.split(',').map(clean).filter(Boolean);
  if (hops.length) return hops.every(mine);
  const host = (req.host ?? '').trim().toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === 'localhost' || isLoopback(host);
}
