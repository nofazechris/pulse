import { z } from 'zod';
import {
  agentReplySchema, agentSessionSchema, apiErrorSchema, apiSuccess, authSessionSchema, diagnosticsSchema, executeResultSchema,
  healthSchema, marketStatsSchema, memorySchema, portfolioSchema, sessionInfoSchema, startSessionResultSchema, tradeProposalSchema, exchangeOrderSchema, type ExchangeOrderDto,
  transcriptionSchema, watchlistSchema, planCheckSchema, tradePlanSchema,
  type PlanCheck, type TradePlan,
  type AgentReply, type AuthSession, type Diagnostics, type ExecuteResult, type Health, type MarketStats, type Memory,
  type Portfolio, type TradeProposal, type Watchlist,
} from '@pulse/shared';

export class ApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown, readonly requestId?: string) {
    super(message);
    this.name = 'ApiRequestError';
  }
  get isNetwork() {
    return this.status === 0;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  getToken: () => string | null;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Called with the request id of every request (correlation across frontend and backend logs). */
  onRequest?: (info: { id: string; method: string; path: string }) => void;
}

const uuid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/** What the app needs from its backend: the real client, or the in-app practice backend. */
export type PulseApi = Pick<ApiClient, keyof ApiClient>;

/** Typed API client. Every response is validated with the shared zod contracts before use. */
export class ApiClient {
  lastError: string | null = null;
  lastRequestId: string | null = null;
  constructor(private readonly o: ApiClientOptions) {}

  newIdempotencyKey(): string {
    return `pulse-${uuid()}`;
  }

  private async request<T extends z.ZodType>(
    schema: T, method: string, path: string, opts: { body?: unknown; raw?: Uint8Array; signal?: AbortSignal; headers?: Record<string, string>; auth?: boolean; timeoutMs?: number } = {},
  ): Promise<z.infer<T>> {
    const id = uuid();
    this.lastRequestId = id;
    this.o.onRequest?.({ id, method, path });
    const headers: Record<string, string> = { 'x-request-id': id, ...(opts.headers ?? {}) };
    const token = this.o.getToken();
    if (opts.auth !== false && token) headers.authorization = `Bearer ${token}`;
    let body: BodyInit | undefined;
    if (opts.raw) {
      headers['content-type'] = 'application/octet-stream';
      body = opts.raw as unknown as BodyInit;
    } else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.o.timeoutMs ?? 20_000);
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;

    let res: Response;
    try {
      res = await (this.o.fetchFn ?? fetch)(`${this.o.baseUrl}/api/v1${path}`, { method, headers, ...(body !== undefined ? { body } : {}), signal });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const e = new ApiRequestError(0, 'NETWORK', 'Cannot reach the PULSE backend.', undefined, id);
      this.lastError = e.message;
      throw e;
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ApiRequestError(res.status, 'BAD_RESPONSE', 'The backend sent an unreadable response.', undefined, id);
    }
    if (!res.ok) {
      const parsed = apiErrorSchema.safeParse(json);
      const e = parsed.success
        ? new ApiRequestError(res.status, parsed.data.error.code, parsed.data.error.message, parsed.data.error.details, id)
        : new ApiRequestError(res.status, 'HTTP_ERROR', `Request failed (${res.status}).`, undefined, id);
      this.lastError = `${e.code}: ${e.message}`;
      throw e;
    }
    const ok = apiSuccess(schema).safeParse(json);
    if (!ok.success) {
      const e = new ApiRequestError(res.status, 'CONTRACT_MISMATCH', 'The backend response did not match the expected contract.', undefined, id);
      this.lastError = e.message;
      throw e;
    }
    return (ok.data as { data: z.infer<T> }).data;
  }

  health = (signal?: AbortSignal): Promise<Health> => this.request(healthSchema, 'GET', '/health', { auth: false, ...(signal ? { signal } : {}) });
  pair = (pairingCode: string, deviceType: 'simulator' | 'g2-glasses' | 'web'): Promise<AuthSession> =>
    this.request(authSessionSchema, 'POST', '/auth/pair', { auth: false, body: { pairingCode, deviceType } });
  session = () => this.request(sessionInfoSchema, 'GET', '/auth/session');
  refresh = (): Promise<AuthSession> => this.request(authSessionSchema, 'POST', '/auth/refresh');
  logout = () => this.request(z.object({ loggedOut: z.boolean() }), 'POST', '/auth/logout');

  startSession = (): Promise<{ session: z.infer<typeof agentSessionSchema>; greeting: AgentReply }> =>
    this.request(startSessionResultSchema, 'POST', '/agent/sessions');
  endSession = (id: string) => this.request(agentSessionSchema, 'POST', `/agent/sessions/${id}/end`);
  message = (
    body: { sessionId: string; text: string; source: 'voice' | 'text'; displayedProposalId?: string }, signal?: AbortSignal,
  ): Promise<AgentReply> => this.request(agentReplySchema, 'POST', '/agent/message', { body, ...(signal ? { signal } : {}) });
  transcribe = (pcm: Uint8Array, signal?: AbortSignal) =>
    this.request(transcriptionSchema, 'POST', '/agent/transcribe', { raw: pcm, ...(signal ? { signal } : {}) });

  portfolio = (signal?: AbortSignal): Promise<Portfolio> => this.request(portfolioSchema, 'GET', '/portfolio', signal ? { signal } : {});
  watchlist = (signal?: AbortSignal): Promise<Watchlist> => this.request(watchlistSchema, 'GET', '/watchlist', signal ? { signal } : {});
  stats = (symbol: string, signal?: AbortSignal): Promise<MarketStats> =>
    this.request(marketStatsSchema, 'GET', `/market/stats/${encodeURIComponent(symbol)}`, signal ? { signal } : {});

  approve = (id: string, body: { sessionId: string; proposalHash: string; method: 'glasses_gesture' | 'voice' }): Promise<TradeProposal> =>
    this.request(tradeProposalSchema, 'POST', `/trades/proposals/${id}/approve`, { body });
  reject = (id: string, sessionId: string): Promise<TradeProposal> =>
    this.request(tradeProposalSchema, 'POST', `/trades/proposals/${id}/reject`, { body: { sessionId } });
  execute = (id: string, idempotencyKey: string): Promise<ExecuteResult> =>
    this.request(executeResultSchema, 'POST', `/trades/proposals/${id}/execute`, { headers: { 'idempotency-key': idempotencyKey }, timeoutMs: 60_000 });
  proposal = (id: string): Promise<TradeProposal> => this.request(tradeProposalSchema, 'GET', `/trades/proposals/${id}`);
  /** Only ever called after the wearer confirms on the lens, for the exact order shown. */
  cancelOrder = (orderId: string): Promise<ExchangeOrderDto> =>
    this.request(exchangeOrderSchema, 'POST', `/trades/orders/${orderId}/cancel`, { timeoutMs: 60_000 });

  plans = (): Promise<TradePlan[]> => this.request(z.array(tradePlanSchema), 'GET', '/plans');
  checkPlans = (sessionId: string): Promise<PlanCheck> => this.request(planCheckSchema, 'POST', '/plans/check', { body: { sessionId } });
  demoReset = () => this.request(z.object({ proposalsClosed: z.number(), sessionsRemoved: z.number(), watchlistReset: z.boolean() }), 'POST', '/demo/reset');
  diagnostics = (): Promise<Diagnostics> => this.request(diagnosticsSchema, 'GET', '/diagnostics');
  memories = (): Promise<Memory[]> => this.request(z.array(memorySchema), 'GET', '/memory');
  deleteMemory = (id: string) => this.request(z.object({ deleted: z.boolean() }), 'DELETE', `/memory/${id}`);
}
