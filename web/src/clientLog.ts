/** Send a diagnostic line to the rune server (GET /api/client-log shows the last 100). */
export function clientLog(level: 'info' | 'warn' | 'error', msg: string, data?: unknown): void {
  try {
    const body = JSON.stringify({ level, msg, data });
    const blob = new Blob([body], { type: 'application/json' });
    if (!navigator.sendBeacon?.('/api/client-log', blob)) {
      void fetch('/api/client-log', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => undefined);
    }
  } catch {
    /* never let logging break the app */
  }
}

let installed = false;
export function installClientLog(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => clientLog('error', `window error: ${e.message}`, { src: e.filename, line: e.lineno }));
  window.addEventListener('unhandledrejection', (e) => clientLog('error', `unhandled rejection: ${String((e.reason as Error)?.message ?? e.reason)}`));
  clientLog('info', 'client start', { secure: window.isSecureContext, eme: 'requestMediaKeySystemAccess' in navigator, url: location.pathname });
}
