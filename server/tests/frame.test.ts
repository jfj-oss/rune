import { describe, it, expect } from 'vitest';
import { embeddableFromHeaders } from '../src/api/frame.js';
const h = (o: Record<string, string>) => new Headers(o);
describe('embeddableFromHeaders', () => {
  it('blocks X-Frame-Options and restrictive frame-ancestors', () => {
    expect(embeddableFromHeaders(h({ 'x-frame-options': 'DENY' }))).toBe(false);
    expect(embeddableFromHeaders(h({ 'x-frame-options': 'SAMEORIGIN' }))).toBe(false);
    expect(embeddableFromHeaders(h({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" }))).toBe(false);
  });
  it('allows pages without restrictions or with frame-ancestors *', () => {
    expect(embeddableFromHeaders(h({}))).toBe(true);
    expect(embeddableFromHeaders(h({ 'content-security-policy': 'frame-ancestors *' }))).toBe(true);
  });
});
