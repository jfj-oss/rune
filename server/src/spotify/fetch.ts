// Minimal structural fetch types so tests can inject fakes without DOM libs and
// the production code can use Node's global fetch directly.

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<any>;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponse>;

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
