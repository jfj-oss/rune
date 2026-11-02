import { useUi } from '../store/ui';

export function Toast() {
  const n = useUi((s) => s.notice);
  return (
    <div className="toastwrap" aria-live="polite">
      {n && <div key={n.id} className="toast">{n.text}</div>}
    </div>
  );
}
