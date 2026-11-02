// Cheerio helpers shared by the Wikipedia ratings and quote parsers.
import type { CheerioAPI } from 'cheerio';
import { cleanText } from './text.js';

/**
 * Map of `cite_note-*` anchor id -> first real external URL in that reference.
 * Archive links are deprioritised: the cited review URL is more useful to the UI.
 */
export function collectRefUrls($: CheerioAPI): Map<string, string> {
  const refs = new Map<string, string>();
  $('li[id^="cite_note-"]').each((_, li) => {
    const id = $(li).attr('id');
    if (!id) return;
    const links = $(li).find('a[href^="http"]').toArray();
    const preferred = links.find((a) => !/web\.archive\.org|archive\.(today|is|ph)/i.test($(a).attr('href') ?? ''));
    const href = $(preferred ?? links[0] ?? li).attr('href');
    if (href && /^https?:/.test(href)) refs.set(id, href.replace(/^http:\/\//i, 'https://'));
  });
  return refs;
}

/** The reference URL attached to a table cell (the current review citation). */
export function citationUrlForCell($: CheerioAPI, cell: unknown, refs: Map<string, string>): string | undefined {
  const href = $(cell as never).find('a[href^="#cite_note-"]').first().attr('href');
  if (!href) return undefined;
  return refs.get(href.slice(1));
}

/** Text of a table cell without the little `[12]` reference superscripts. */
export function cellText($: CheerioAPI, cell: unknown): string {
  const $cell = $(cell as never).clone();
  $cell.find('sup, .reference, .cite-bracket').remove();
  return cleanText($cell.text());
}

/** Reference URLs cited inside a paragraph (original DOM, before cloning). */
export function paragraphUrls($: CheerioAPI, paragraph: unknown, refs: Map<string, string>): string[] {
  const urls: string[] = [];
  $(paragraph as never)
    .find('a[href^="#cite_note-"]')
    .each((_, a) => {
      const href = $(a).attr('href');
      if (!href) return;
      const url = refs.get(href.slice(1));
      if (url && !urls.includes(url)) urls.push(url);
    });
  return urls;
}

export function hostMatches(url: string, host: string): boolean {
  try {
    const h = new URL(url).host;
    return h === host || h.endsWith(`.${host}`);
  } catch {
    return false;
  }
}
