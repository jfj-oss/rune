#!/usr/bin/env python3
"""native-perf.py <url> <bin> <W> <H> : idle RAM/CPU and Albums-grid scroll frame times of rune-desktop in the private KWin."""
import json, os, socket, subprocess, sys, time
url, binp, W, H = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
assert ':4545' not in url
RG = os.environ.get('RG', os.path.expanduser('~/data/agent-tmp/rune-gpui'))
env = dict(os.environ)
env.update(WAYLAND_DISPLAY='wayland-runegpui', DBUS_SESSION_BUS_ADDRESS=open(RG + '/run/bus').read().strip(), XDG_CONFIG_HOME=RG + '/run/app-config',
           RUNE_DESKTOP_CONFIG_DIR=RG + '/run/app-config/rune-desktop-perf', RUNE_DESKTOP_URL=url, RUNE_DESKTOP_ROUTE='/albums', RUNE_DESKTOP_SIZE=f'{W}x{H}', RUNE_DESKTOP_TEST_PORT='24690')
env.pop('DISPLAY', None)
p = subprocess.Popen([binp], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
def call(c, tmo=120):
    for _ in range(100):
        try:
            s = socket.create_connection(('127.0.0.1', 24690)); break
        except OSError: time.sleep(0.3)
    s.settimeout(tmo); s.sendall((json.dumps(c) + '\n').encode()); d = b''
    while not d.endswith(b'\n'): d += s.recv(65536)
    s.close(); return json.loads(d)
def pss(): return int([l for l in open(f'/proc/{p.pid}/smaps_rollup') if l.startswith('Pss:')][0].split()[1]) / 1024
def ticks():
    f = open(f'/proc/{p.pid}/stat').read().split(')')[1].split(); return int(f[11]) + int(f[12])
try:
    while not call({'cmd': 'state'}).get('online'): time.sleep(0.5)
    time.sleep(8)
    t0, s0 = ticks(), time.time(); time.sleep(10)
    res = {'idle_pss_mb': round(pss()), 'idle_cpu_pct_of_one_core': round((ticks() - t0) / 100 / (time.time() - s0) * 100, 1)}
    for name, dy in (('scroll_40px_per_frame', 40), ('scroll_200px_per_frame', 200)):
        call({'cmd': 'scroll', 'dy': -1e6}); time.sleep(1.5)
        r = call({'cmd': 'bench', 'steps': 300, 'dy': dy, 'ms': 16}); res[name] = {k: (round(v, 1) if isinstance(v, float) else v) for k, v in r.items()}
    st = call({'cmd': 'state'})
    res['after_scroll_pss_mb'] = round(pss()); res['covers_held'] = st['covers_held']; res['covers_mb'] = round(st['covers_bytes'] / 2**20); res['albums_loaded'] = st['albums_loaded']
    print(json.dumps(res))
finally:
    p.terminate()
