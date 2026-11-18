/**
 * Transport abstraction. In the plugin this is backed by Obsidian's
 * `requestUrl` (src/obsidian/obsidianHttp.ts), which bypasses CORS on desktop
 * and iOS. Tests inject a fake. Nothing here may use Node APIs.
 */
export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  contentType?: string;
}

export interface HttpResponse {
  status: number;
  /** header names lower-cased */
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  text: string;
}

export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

export class HttpError extends Error {
  constructor(readonly status: number, readonly body: string, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export function lowerHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = v;
  return out;
}

export function parseJson<T>(res: HttpResponse): T {
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new HttpError(res.status, res.text.slice(0, 300), `expected JSON from Google (HTTP ${res.status})`);
  }
}

const RATE_LIMIT_REASONS = ["rateLimitExceeded", "userRateLimitExceeded", "backendError"];

/** Should this response be retried with backoff? */
export function isRetryable(res: HttpResponse): boolean {
  if (res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) return true;
  if (res.status === 403) return RATE_LIMIT_REASONS.some((r) => res.text.includes(r));
  return false;
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (attempt: number, delayMs: number, why: string) => void;
  /** Stop retrying immediately when this returns true (e.g. the device went offline). */
  giveUp?: () => boolean;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Rejected before the server did anything: always safe to retry. */
function isRateLimited(res: HttpResponse): boolean {
  return res.status === 429 || (res.status === 403 && RATE_LIMIT_REASONS.slice(0, 2).some((r) => res.text.includes(r)));
}

/**
 * A request that creates something (new file via multipart upload, new folder).
 * If the connection dies after Drive committed it, blindly re-sending would create
 * a DUPLICATE. Those are only retried on explicit rate-limit replies; anything
 * else is left to the next sync, which adopts what was created.
 */
export function isNonIdempotent(req: HttpRequest): boolean {
  const m = (req.method ?? "GET").toUpperCase();
  return m === "POST" && !req.url.includes("uploadType=resumable") && !req.url.startsWith("https://oauth2.googleapis.com/");
}

/** Wrap a transport with exponential backoff + jitter for 403-rate-limit/429/5xx and network errors. */
export function withRetry(http: HttpFn, opts: RetryOptions = {}): HttpFn {
  const maxRetries = opts.maxRetries ?? 6;
  const base = opts.baseDelayMs ?? 1000;
  const cap = opts.maxDelayMs ?? 32000;
  const doSleep = opts.sleep ?? sleep;
  const rnd = opts.random ?? Math.random;
  return async (req) => {
    for (let attempt = 0; ; attempt++) {
      let res: HttpResponse | undefined;
      let netErr: unknown;
      try {
        res = await http(req);
      } catch (e) {
        netErr = e;
      }
      const retry = isNonIdempotent(req)
        ? res !== undefined && isRateLimited(res)
        : netErr !== undefined || (res !== undefined && isRetryable(res));
      if (!retry || attempt >= maxRetries || opts.giveUp?.()) {
        if (netErr !== undefined) throw netErr;
        return res!;
      }
      let delay = Math.min(cap, base * 2 ** attempt) + Math.floor(rnd() * 1000);
      const ra = res?.headers["retry-after"];
      if (ra && /^\d+$/.test(ra)) delay = Math.max(delay, Number(ra) * 1000);
      opts.onRetry?.(attempt + 1, delay, netErr !== undefined ? String(netErr) : `HTTP ${res!.status}`);
      await doSleep(delay);
    }
  };
}
