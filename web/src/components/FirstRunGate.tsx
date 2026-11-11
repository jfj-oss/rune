import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { isMock } from '../api';
import { setupApi } from '../setupApi';

/** On a fresh install (no music folder yet) the first page opened is the setup page. Only once per page load, so it never traps you. */
export function FirstRunGate() {
  const nav = useNavigate();
  const loc = useLocation();
  const done = useRef(false);
  const q = useQuery({ queryKey: ['setup-gate'], queryFn: () => setupApi.status(), enabled: !isMock, staleTime: Infinity, retry: false });
  useEffect(() => {
    if (done.current || !q.data) return;
    done.current = true;
    if (q.data.needsSetup && loc.pathname !== '/setup') nav('/setup', { replace: true });
  }, [q.data, loc.pathname, nav]);
  return null;
}
