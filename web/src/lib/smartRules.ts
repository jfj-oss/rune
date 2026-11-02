// Field / operator metadata for the smart-playlist rule builder (what server/src/myplaylists/rules.ts accepts).
import type { SmartField, SmartRule } from './playlists';

export interface OpDef { op: string; label: string; noValue?: boolean }
export interface FieldDef {
  label: string;
  kind: 'text' | 'number' | 'date' | 'enum';
  ops: OpDef[];
  options?: string[];
  placeholder?: string;
}

const TEXT_OPS: OpDef[] = [
  { op: 'contains', label: 'contains' },
  { op: 'eq', label: 'is' },
  { op: 'ne', label: 'is not' },
  { op: 'notContains', label: 'does not contain' },
  { op: 'startsWith', label: 'starts with' },
];
const NUM_OPS: OpDef[] = [
  { op: 'eq', label: 'is' },
  { op: 'gte', label: 'is at least' },
  { op: 'lte', label: 'is at most' },
  { op: 'gt', label: 'is more than' },
  { op: 'lt', label: 'is less than' },
  { op: 'between', label: 'is between' },
];
const DATE_OPS: OpDef[] = [
  { op: 'gt', label: 'is after' },
  { op: 'lt', label: 'is before' },
  { op: 'between', label: 'is between' },
];

export const FIELDS: Record<SmartField, FieldDef> = {
  genre: { label: 'Genre', kind: 'text', ops: TEXT_OPS, placeholder: 'Jazz' },
  artist: { label: 'Artist', kind: 'text', ops: TEXT_OPS, placeholder: 'Artist name' },
  year: { label: 'Year', kind: 'number', ops: NUM_OPS, placeholder: '1990' },
  format: { label: 'Format', kind: 'text', ops: TEXT_OPS.slice(0, 3), placeholder: 'FLAC' },
  source: { label: 'Source', kind: 'enum', ops: [{ op: 'eq', label: 'is' }, { op: 'ne', label: 'is not' }], options: ['local', 'spotify'] },
  added: { label: 'Date added', kind: 'date', ops: DATE_OPS },
  plays: { label: 'Play count', kind: 'number', ops: NUM_OPS.filter((o) => o.op !== 'between'), placeholder: '0' },
  lastPlayed: { label: 'Last played', kind: 'date', ops: [{ op: 'never', label: 'never', noValue: true }, { op: 'played', label: 'has been played', noValue: true }, ...DATE_OPS] },
};

export const SORTS: { field: string; label: string }[] = [
  { field: 'artist', label: 'Artist' },
  { field: 'title', label: 'Title' },
  { field: 'album', label: 'Album' },
  { field: 'year', label: 'Year' },
  { field: 'added', label: 'Date added' },
  { field: 'plays', label: 'Play count' },
  { field: 'lastPlayed', label: 'Last played' },
  { field: 'duration', label: 'Length' },
];

/** One row of the builder while it is being edited (values are raw strings from the inputs). */
export interface RuleDraft { field: SmartField; op: string; a: string; b: string }

export function blankRule(field: SmartField): RuleDraft {
  const f = FIELDS[field];
  return { field, op: f.ops[0]!.op, a: f.kind === 'enum' ? f.options![0]! : '', b: '' };
}

const needsValue = (r: RuleDraft) => !FIELDS[r.field].ops.find((o) => o.op === r.op)?.noValue;

export function ruleComplete(r: RuleDraft): boolean {
  if (!needsValue(r)) return true;
  const f = FIELDS[r.field];
  const ok = (v: string) => (f.kind === 'number' ? v.trim() !== '' && Number.isFinite(Number(v)) : v.trim() !== '');
  return ok(r.a) && (r.op !== 'between' || ok(r.b));
}
export const specComplete = (rules: RuleDraft[]) => rules.length > 0 && rules.every(ruleComplete);

/** The wire form of a rule (numbers as numbers, dates as ISO strings). */
export function ruleToSpec(r: RuleDraft): SmartRule {
  if (!needsValue(r)) return { field: r.field, op: r.op };
  const kind = FIELDS[r.field].kind;
  const conv = (v: string) => (kind === 'number' ? Number(v) : v.trim());
  return { field: r.field, op: r.op, value: r.op === 'between' ? [conv(r.a), conv(r.b)] : conv(r.a) };
}
