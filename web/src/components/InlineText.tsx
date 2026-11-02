import { Pencil } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

interface Props {
  value: string;
  onCommit(v: string): void;
  /** shown (dim) when empty; with `editable` it is also the "add one" prompt */
  placeholder?: string;
  editable?: boolean;
  multiline?: boolean;
  maxLength?: number;
  className?: string;
  label: string;
  /** an empty value is allowed to be saved (description) */
  allowEmpty?: boolean;
}

/** Click-to-edit text. Enter (or leaving the field) saves, Esc cancels. */
export function InlineText({ value, onCommit, placeholder, editable, multiline, maxLength, className = '', label, allowEmpty }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const done = useRef(false);

  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  useEffect(() => { if (editing) { done.current = false; ref.current?.focus(); ref.current?.select(); } }, [editing]);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const v = draft.trim();
    if (v === value.trim() || (!v && !allowEmpty)) { setDraft(value); return; }
    onCommit(v);
  };
  const cancel = () => { done.current = true; setDraft(value); setEditing(false); };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
    else if (e.key === 'Enter' && !(multiline && e.shiftKey)) { e.preventDefault(); commit(); }
  };

  if (!editable) return value ? <span className={className}>{value}</span> : null;
  if (editing) {
    const common = { ref, value: draft, maxLength, 'aria-label': label, className: `inlinetext__input ${className}`, onChange: (e: { target: { value: string } }) => setDraft(e.target.value), onBlur: commit, onKeyDown: key };
    return multiline ? <textarea rows={2} {...common} /> : <input {...common} />;
  }
  return (
    <button type="button" className={`inlinetext ${value ? '' : 'inlinetext--empty'} ${className}`} onClick={() => setEditing(true)} aria-label={`Edit ${label}`} title={`Edit ${label}`}>
      <span>{value || placeholder}</span>
      <Pencil size={14} className="inlinetext__pen" aria-hidden />
    </button>
  );
}
