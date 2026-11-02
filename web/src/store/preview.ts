import type { CriticScore } from '@liner/shared';
import { create } from 'zustand';

/** What the in-app review preview shows. Everything here is text rune already stores. */
export interface PreviewItem {
  kind: 'quote' | 'score' | 'text';
  /** Eyebrow: "Review", "Score", "Critical reception", ... */
  label: string;
  /** Outlet or source name, shown large. */
  title: string;
  author?: string;
  quote?: string;
  score?: CriticScore;
  /** Full stored text (reception / background / artist note / bio), CC BY-SA or Genius. */
  text?: string;
  /** The page the content came from; "Open original" frames it when the site allows. */
  url: string;
  /** Where else in the stored Wikipedia text this critic is mentioned. */
  context?: { source: string; url: string; sentences: string[]; terms: string[] };
  /** Attribution line for stored third-party text (shown whenever text is). */
  attribution?: { source: string; url: string };
}

interface PreviewStore {
  item: PreviewItem | null;
  open(item: PreviewItem): void;
  close(): void;
}

export const usePreview = create<PreviewStore>((set) => ({
  item: null,
  open: (item) => set({ item }),
  close: () => set({ item: null }),
}));
