import { createHmac } from 'node:crypto';
import { assertTestnetRestUrl } from './guard';
import { ExchangeNotConfiguredError, ExchangeRejectedError, ExchangeUnavailableError } from './types';

/**
 * Endpoint allow-list. Withdrawals, deposits, transfers, margin and futures are unreachable
 * because they are simply not on this list.
 */
export const ALLOWED_ENDPOINTS: ReadonlySet<string> = new Set([
  'GET /v3/ping',
  'GET /v3/time',
  'GET /v3/exchangeInfo',
  'GET /v3/ticker/price',
  'GET /v3/ticker/24hr',
  'GET /v3/account',
  'GET /v3/openOrders',
  'GET /v3/allOrders',
  'GET /v3/order',
  'POST /v3/order',
  'DELETE /v3/order',
]);

export interface BinanceClientOptions {
  restUrl: string;
  apiKey?: string | undefined;
  apiSecret?: string | undefined;
  timeoutMs?: number;
  readRetries?: number;
  fetchFn?: typeof fetch;
  log?: { debug: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
}

type Params = Record<string, string | number | undefined>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BinanceClient {
  readonly restUrl: string;
  private readonly apiKey: string | undefined;
  private readonly apiSecret: string | undefined;
  private readonly timeoutMs: number;
  private readonly readRetries: number;
  private readonly fetchFn: typeof fetch;
  private readonly log: BinanceClientOptions['log'];
  private timeOffsetMs = 0;
  private lastSync = 0;

  constructor(opts: BinanceClientOptions) {
    // Re-validated here: even if env validation were bypassed, a non-testnet URL cannot get this far.
    this.restUrl = assertTestnetRestUrl(opts.restUrl);
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.readRetries = opts.readRetries ?? 2;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.log = opts.log;
  }

  get hasCredentials(): boolean {
    return Boolean(this.apiKey && this.apiSecret);
  }

  async publicGet<T>(path: string, params: Params = {}): Promise<T> {
    return this.withReadRetry(() => this.request<T>('GET', path, params, false));
  }

  async signedGet<T>(path: string, params: Params = {}): Promise<T> {
    return this.withReadRetry(() => this.request<T>('GET', path, params, true));
  }

  /** Writes are NEVER retried here (an uncertain outcome must be reconciled by the caller). */
  async signedWrite<T>(method: 'POST' | 'DELETE', path: string, params: Params): Promise<T> {
    try {
      return await this.request<T>(method, path, params, true);
    } catch (err) {
      // -1021 = timestamp outside recvWindow: Binance rejected it before processing, so one resync+retry is safe.
      if (err instanceof ExchangeRejectedError && err.code === -1021) {
        await this.syncTime(true);
        return this.request<T>(method, path, params, true);
      }
      throw err;
    }
  }

  private async withReadRetry<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof ExchangeUnavailableError) || attempt >= this.readRetries) throw err;
        attempt++;
        await sleep(200 * 3 ** (attempt - 1));
      }
    }
  }

  private async syncTime(force = false): Promise<void> {
    if (!force && Date.now() - this.lastSync < 10 * 60_000) return;
    const t0 = Date.now();
    const res = await this.request<{ serverTime: number }>('GET', '/v3/time', {}, false);
    const t1 = Date.now();
    this.timeOffsetMs = res.serverTime - Math.round((t0 + t1) / 2);
    this.lastSync = Date.now();
  }

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Params, signed: boolean): Promise<T> {
    if (!ALLOWED_ENDPOINTS.has(`${method} ${path}`)) {
      throw new Error(`Endpoint not allowed: ${method} ${path}`);
    }
    if (signed && !this.hasCredentials) throw new ExchangeNotConfiguredError();
    if (signed) await this.syncTime();

    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) search.set(k, String(v));
    if (signed) {
      search.set('recvWindow', '5000');
      search.set('timestamp', String(Date.now() + this.timeOffsetMs));
      const signature = createHmac('sha256', this.apiSecret!).update(search.toString()).digest('hex');
      search.set('signature', signature);
    }
    const url = `${this.restUrl}${path}${search.size ? `?${search}` : ''}`;
    const started = Date.now();

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers: signed || this.apiKey ? { 'X-MBX-APIKEY': this.apiKey ?? '' } : {},
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'network error';
      throw new ExchangeUnavailableError(`Binance Testnet request ${reason}`);
    }

    this.log?.debug({ method, path, status: res.status, ms: Date.now() - started }, 'binance request');

    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = undefined;
    }

    if (!res.ok) {
      if (res.status >= 500 || res.status === 429 || res.status === 418) {
        throw new ExchangeUnavailableError(`Binance Testnet unavailable (HTTP ${res.status})`);
      }
      const b = (body ?? {}) as { code?: number; msg?: string };
      throw new ExchangeRejectedError(res.status, b.code, b.msg ?? 'Request rejected');
    }
    if (body === undefined) throw new ExchangeUnavailableError('Binance Testnet returned an unreadable response');
    return body as T;
  }
}
