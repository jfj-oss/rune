import { ChevronLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

/** Back chevron for the installed mobile app (no browser chrome); hidden on desktop and on first page. */
export function MobileBack() {
  const nav = useNavigate();
  const idx = (window.history.state?.idx as number | undefined) ?? 0;
  if (idx <= 0) return null;
  return <button className="mback" aria-label="Back" onClick={() => nav(-1)}><ChevronLeft size={22} /></button>;
}
