import { describe, expect, it } from 'vitest';
import type { AlbumDetails } from '@liner/shared';
import { scorePreview } from './previews';

const details = {
  albumId: 'a',
  scores: [],
  quotes: [{ outlet: 'The Guardian', author: 'Alexis Petridis', quote: 'Lovely.', url: 'https://example.org/g' }],
} as unknown as AlbumDetails;

describe('scorePreview', () => {
  it('brings in the same outlet\'s stored excerpt (ignoring a leading "The")', () => {
    const p = scorePreview({ outlet: 'Guardian', score: 4, scale: 5, url: 'https://example.org/g' }, details);
    expect(p.quote).toBe('Lovely.');
    expect(p.author).toBe('Alexis Petridis');
  });
  it('has no quote when no excerpt from that outlet is stored', () => {
    const p = scorePreview({ outlet: 'Pitchfork', score: 8, scale: 10, url: 'https://example.org/p' }, details);
    expect(p.quote).toBeUndefined();
  });
});
