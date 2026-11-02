// Extract attributed critic statements from Wikipedia reception prose, e.g.
// "AllMusic's Steve Huey wrote that…", "Robert Christgau called it…",
// "Rolling Stone said…". These are real excerpts (never generated); the cited
// reference URL for the sentence is preferred over a search URL.
import type { CriticQuote } from '@liner/shared';
import { hostMatches } from './html.js';
import { cleanText, truncateQuote } from './text.js';

export interface ProseParagraph {
  text: string;
  urls: string[];
}

interface OutletPattern {
  outlet: string;
  re: RegExp;
  hosts: string[];
}

const OUTLETS: OutletPattern[] = [
  { outlet: 'AllMusic', re: /\bAllMusic\b/i, hosts: ['allmusic.com'] },
  { outlet: 'Rolling Stone', re: /\bRolling Stone\b/i, hosts: ['rollingstone.com'] },
  { outlet: 'Pitchfork', re: /\bPitchfork(?: Media)?\b/i, hosts: ['pitchfork.com'] },
  { outlet: 'Robert Christgau', re: /\b(?:Robert )?Christgau\b/i, hosts: ['robertchristgau.com'] },
  { outlet: 'The Village Voice', re: /\bVillage Voice\b/i, hosts: ['villagevoice.com'] },
  { outlet: 'NME', re: /\bNME\b/i, hosts: ['nme.com'] },
  { outlet: 'Q', re: /\bQ(?: magazine)?\b/, hosts: ['qthemusic.com'] },
  { outlet: 'Mojo', re: /\bMojo\b/i, hosts: ['mojo4music.com'] },
  { outlet: 'Uncut', re: /\bUncut\b/i, hosts: ['uncut.co.uk'] },
  { outlet: 'Spin', re: /\bSpin\b/i, hosts: ['spin.com'] },
  { outlet: 'Entertainment Weekly', re: /\bEntertainment Weekly\b/i, hosts: ['ew.com'] },
  { outlet: 'The Guardian', re: /\b(?:The )?Guardian\b/i, hosts: ['theguardian.com'] },
  { outlet: 'The New York Times', re: /\bNew York Times\b/i, hosts: ['nytimes.com'] },
  { outlet: 'Los Angeles Times', re: /\bLos Angeles Times\b/i, hosts: ['latimes.com'] },
  { outlet: 'Chicago Tribune', re: /\bChicago Tribune\b/i, hosts: ['chicagotribune.com'] },
  { outlet: 'The A.V. Club', re: /\bA\.?V\.? Club\b/i, hosts: ['avclub.com'] },
  { outlet: 'Slant Magazine', re: /\bSlant(?: Magazine)?\b/i, hosts: ['slantmagazine.com'] },
  { outlet: 'PopMatters', re: /\bPopMatters\b/i, hosts: ['popmatters.com'] },
  { outlet: 'Sputnikmusic', re: /\bSputnikmusic\b/i, hosts: ['sputnikmusic.com'] },
  { outlet: 'Billboard', re: /\bBillboard\b/i, hosts: ['billboard.com'] },
  { outlet: 'The Independent', re: /\b(?:The )?Independent\b/i, hosts: ['independent.co.uk'] },
  { outlet: 'The New York Observer', re: /\bNew York Observer\b/i, hosts: ['observer.com'] },
  { outlet: 'The Observer', re: /\b(?:The )?Observer\b/i, hosts: ['theguardian.com'] },
  { outlet: 'Newsweek', re: /\bNewsweek\b/i, hosts: ['newsweek.com'] },
  { outlet: 'Time', re: /\bTime\b/, hosts: ['time.com'] },
  { outlet: 'Vibe', re: /\bVibe\b/i, hosts: ['vibe.com'] },
  { outlet: 'Stereogum', re: /\bStereogum\b/i, hosts: ['stereogum.com'] },
  { outlet: 'Consequence', re: /\bConsequence(?: of Sound)?\b/i, hosts: ['consequence.net'] },
  { outlet: 'Paste', re: /\bPaste(?: Magazine)?\b/i, hosts: ['pastemagazine.com'] },
  { outlet: 'Exclaim!', re: /\bExclaim!\b/i, hosts: ['exclaim.ca'] },
  { outlet: 'Drowned in Sound', re: /\bDrowned in Sound\b/i, hosts: ['drownedinsound.com'] },
  { outlet: 'The Quietus', re: /\bQuietus\b/i, hosts: ['thequietus.com'] },
];

/** Critics whose name is enough to attribute a sentence (their outlet is implied). */
const KNOWN_CRITICS: { re: RegExp; author: string; outlet: string; hosts: string[] }[] = [
  { re: /\bRobert Christgau\b/i, author: 'Robert Christgau', outlet: 'Robert Christgau', hosts: ['robertchristgau.com'] },
  { re: /\bSteve Huey\b/i, author: 'Steve Huey', outlet: 'AllMusic', hosts: ['allmusic.com'] },
  { re: /\bStephen Thomas Erlewine\b/i, author: 'Stephen Thomas Erlewine', outlet: 'AllMusic', hosts: ['allmusic.com'] },
  { re: /\bLindsay Planer\b/i, author: 'Lindsay Planer', outlet: 'AllMusic', hosts: ['allmusic.com'] },
  { re: /\bThom Jurek\b/i, author: 'Thom Jurek', outlet: 'AllMusic', hosts: ['allmusic.com'] },
  { re: /\bGreg Kot\b/i, author: 'Greg Kot', outlet: 'Chicago Tribune', hosts: ['chicagotribune.com'] },
  { re: /\bVince Aletti\b/i, author: 'Vince Aletti', outlet: 'Rolling Stone', hosts: ['rollingstone.com'] },
];

const ATTRIBUTION_VERB =
  /\b(wrote|writes|writing|said|says|stated|called|calls|described|remarked|noted|opined|argued|commented|found|felt|considered|deemed|hailed|praised|criticized|criticised|panned|dismissed|observed|concluded|singled|added|reported|viewed|characterized|characterised)\b/i;

const NAME = "[A-Z][\\w'’.-]+(?:\\s+[A-Z][\\w'’.-]+){1,2}";

/** Split prose into sentences without cutting common abbreviations. */
export function splitSentences(text: string): string[] {
  const normalised = cleanText(text);
  if (!normalised) return [];
  const parts = normalised.match(/[^.!?]+[.!?]+(?:["”’']+)?|[^.!?]+$/g) ?? [normalised];
  const out: string[] = [];
  for (const raw of parts) {
    const sentence = raw.trim();
    if (!sentence) continue;
    // Re-join fragments produced after "Mr." / "U.S." style abbreviations or
    // initials. A real sentence starts with a capital and has enough length.
    if (out.length > 0 && sentence.length < 25 && !/[.!?]$/.test(out[out.length - 1]!.slice(-1))) {
      out[out.length - 1] = `${out[out.length - 1]} ${sentence}`;
    } else if (out.length > 0 && /(?:^|\s)(?:Mr|Mrs|Ms|Dr|St|vs|etc|U\.S|No)\.$/.test(out[out.length - 1]!)) {
      out[out.length - 1] = `${out[out.length - 1]} ${sentence}`;
    } else {
      out.push(sentence);
    }
  }
  return out;
}

interface Attribution {
  outlet: string;
  author?: string;
}

function outletIn(sentence: string): OutletPattern | null {
  let best: { pattern: OutletPattern; index: number } | null = null;
  for (const pattern of OUTLETS) {
    const m = pattern.re.exec(sentence);
    if (!m) continue;
    const index = m.index;
    if (!best || index < best.index) best = { pattern, index };
  }
  return best?.pattern ?? null;
}

function authorFor(sentence: string, outlet: OutletPattern | null): string | undefined {
  if (outlet) {
    const outletRe = outlet.re.source.replace(/^\\b|\\b$/g, '');
    const ofAuthor = new RegExp(`(${NAME})\\s+(?:of|at|from)\\s+(?:the\\s+)?(?:${outletRe})`, 'i').exec(sentence);
    if (ofAuthor?.[1]) return ofAuthor[1];
    const possessive = new RegExp(`(?:${outletRe})['’]s\\s+(${NAME})`, 'i').exec(sentence);
    if (possessive?.[1]) return possessive[1];
    const writingFor = new RegExp(`(${NAME}),?\\s+(?:writing|reviewing|critic)\\b[^.]*?(?:for|in)\\s+(?:the\\s+)?(?:${outletRe})`, 'i').exec(
      sentence,
    );
    if (writingFor?.[1]) return writingFor[1];
  }
  for (const critic of KNOWN_CRITICS) {
    if (critic.re.test(sentence)) return critic.author;
  }
  return undefined;
}

/**
 * The case-insensitive name regex can swallow the attribution verb
 * ("Steve Huey wrote"); drop a trailing verb from the captured name.
 */
function cleanAuthor(author: string | undefined): string | undefined {
  if (!author) return undefined;
  const words = author.split(/\s+/).filter(Boolean);
  while (words.length > 1 && ATTRIBUTION_VERB.test(words[words.length - 1] ?? '')) words.pop();
  return words.join(' ') || undefined;
}

function detectAttribution(sentence: string): Attribution | null {
  const outlet = outletIn(sentence);
  const knownCritic = KNOWN_CRITICS.find((c) => c.re.test(sentence));
  const author = cleanAuthor(authorFor(sentence, outlet));
  if (!outlet && !knownCritic) return null;
  // "According to Billboard, the album peaked at..." is a chart fact, not a
  // critic statement; require an actual attribution verb.
  if (!ATTRIBUTION_VERB.test(sentence)) return null;
  const resolvedOutlet = outlet?.outlet ?? knownCritic!.outlet;
  return {
    outlet: resolvedOutlet,
    ...(author ?? knownCritic?.author ? { author: author ?? knownCritic?.author } : {}),
  };
}

function urlFor(outlet: string, urls: string[], fallbackUrl: string): string {
  const pattern = OUTLETS.find((o) => o.outlet === outlet);
  const critic = KNOWN_CRITICS.find((c) => c.outlet === outlet);
  const hosts = [...(pattern?.hosts ?? []), ...(critic?.hosts ?? [])];
  for (const host of hosts) {
    const match = urls.find((u) => hostMatches(u, host));
    if (match) return match;
  }
  return urls[0] ?? fallbackUrl;
}

/**
 * Up to `max` attributed critic statements. The whole sentence is kept (it is
 * an excerpt, not a rewrite) and truncated to 300 chars at a word boundary.
 */
export function extractQuotes(
  paragraphs: ProseParagraph[],
  fallbackUrl: string,
  max = 4,
): CriticQuote[] {
  const quotes: CriticQuote[] = [];
  const seen = new Set<string>();
  for (const paragraph of paragraphs) {
    for (const sentence of splitSentences(paragraph.text)) {
      if (quotes.length >= max) return quotes;
      if (sentence.length < 40) continue;
      const attribution = detectAttribution(sentence);
      if (!attribution) continue;
      // A sentence can start with the tail of a parenthetical (") Likewise, ...").
      const excerpt = sentence.replace(/^[)\]}"'’\s]+/, '').trim();
      if (excerpt.length < 40) continue;
      const quote = truncateQuote(excerpt, 300);
      const key = `${attribution.outlet.toLowerCase()}|${quote.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      quotes.push({
        outlet: attribution.outlet,
        quote,
        url: urlFor(attribution.outlet, paragraph.urls, fallbackUrl),
        ...(attribution.author ? { author: attribution.author } : {}),
      });
    }
  }
  return quotes;
}
