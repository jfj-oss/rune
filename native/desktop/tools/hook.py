#!/usr/bin/env python3
"""hook.py <port> '<json>' ['<json>' ...]  [--sleep s] : send line-JSON commands to the app's test control port and print the replies."""
import json, socket, sys, time
port = int(sys.argv[1]); cmds = [a for a in sys.argv[2:] if not a.startswith('--')]
s = socket.create_connection(('127.0.0.1', port), timeout=70); f = s.makefile('rw')
for c in cmds:
    if c.startswith('sleep '): time.sleep(float(c[6:])); continue
    f.write(c + '\n'); f.flush(); print(f.readline().strip())
