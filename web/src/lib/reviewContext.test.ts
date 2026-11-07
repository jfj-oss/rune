import { describe, expect, it } from 'vitest';
import { quotesNotInReception, highlightSegments, sentencesMentioning, splitSentences, termsFor } from './reviewContext';

const TEXT =
  'The album was widely praised. Tone Quarterly called it "occasionally too polite." Metacritic gave it 84 out of 100. A second paragraph follows.\n\nPitchfork awarded it 8.1.';

describe('reviewContext', () => {
  it('splits sentences across paragraphs', () => {
    expect(splitSentences(TEXT)).toHaveLength(5);
  });
  it('finds sentences mentioning an outlet', () => {
    expect(sentencesMentioning(TEXT, termsFor('Tone Quarterly'))).toEqual(['Tone Quarterly called it "occasionally too polite."']);
    expect(sentencesMentioning(TEXT, termsFor('Metacritic'))).toHaveLength(1);
    expect(sentencesMentioning(TEXT, termsFor('The Long Player'))).toEqual([]);
  });
  it('matches whole words only and drops "The"', () => {
    expect(termsFor('The Harbour Review', 'M. Calloway')).toEqual(['Harbour Review', 'Calloway']);
    expect(sentencesMentioning('Pitchforks are sharp.', ['Pitchfork'])).toEqual([]);
  });
  it('highlights matches', () => {
    expect(highlightSegments('Metacritic gave 84.', ['metacritic'])).toEqual([
      { text: 'Metacritic', hit: true },
      { text: ' gave 84.', hit: false },
    ]);
  });
});

describe('quotesNotInReception', () => {
  const rec = 'Paul Evans of Rolling Stone called the EP "darkly gorgeous", and Steve Huey stated "Jar of Flies is a low-key stunner."';
  it('drops a quote the reception already prints, keeps others', () => {
    const dup = { quote: 'Paul Evans of Rolling Stone called the EP "darkly gorgeous", and Steve Huey stated "Jar of Flies is a low-key stunner."' };
    const other = { quote: 'A quiet, patient record that earns its ending.' };
    expect(quotesNotInReception([dup, other], rec)).toEqual([other]);
  });
  it('keeps everything without a reception', () => {
    expect(quotesNotInReception([{ quote: 'x y z' }], undefined)).toHaveLength(1);
  });
});
