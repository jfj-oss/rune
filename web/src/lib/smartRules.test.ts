import { describe, expect, it } from 'vitest';
import { blankRule, ruleComplete, ruleToSpec, specComplete } from './smartRules';

describe('smart rule drafts', () => {
  it('is incomplete until its values are filled in', () => {
    const r = blankRule('year');
    expect(ruleComplete(r)).toBe(false);
    expect(ruleComplete({ ...r, a: '1990' })).toBe(true);
    expect(ruleComplete({ ...r, op: 'between', a: '1990' })).toBe(false);
    expect(ruleComplete({ ...r, op: 'between', a: '1990', b: '1999' })).toBe(true);
    expect(specComplete([])).toBe(false);
  });
  it('sends numbers as numbers, dates as strings, and no value for never/played', () => {
    expect(ruleToSpec({ field: 'year', op: 'gte', a: '1990', b: '' })).toEqual({ field: 'year', op: 'gte', value: 1990 });
    expect(ruleToSpec({ field: 'year', op: 'between', a: '1990', b: '1999' })).toEqual({ field: 'year', op: 'between', value: [1990, 1999] });
    expect(ruleToSpec({ field: 'added', op: 'gt', a: '2024-01-01', b: '' })).toEqual({ field: 'added', op: 'gt', value: '2024-01-01' });
    expect(ruleToSpec({ field: 'lastPlayed', op: 'never', a: '', b: '' })).toEqual({ field: 'lastPlayed', op: 'never' });
    expect(ruleComplete({ field: 'lastPlayed', op: 'never', a: '', b: '' })).toBe(true);
    expect(ruleToSpec({ field: 'genre', op: 'contains', a: ' Jazz ', b: '' })).toEqual({ field: 'genre', op: 'contains', value: 'Jazz' });
  });
  it('source is an enum that starts valid', () => {
    expect(ruleComplete(blankRule('source'))).toBe(true);
  });
});
