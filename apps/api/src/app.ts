import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { and, eq, notExists, sql } from 'drizzle-orm';
import {
  addWatchlistSchema, agentMessageRequestSchema, approveTradeSchema, createMemorySchema, createPlanSchema, pairRequestSchema,
  patchMemorySchema, prepareTradeSchema, type Diagnostics, type Health,
} from '@pulse/shared';
import { z } from 'zod';
import type { Env } from './config/env';
import { agentSessions, tradeProposals, watchlists } from './db/schema';
import type { AuthContext } from './modules/sessions/auth';
import { toSessionDto } from './modules/sessions/agent-sessions';
import { createServices, type ServiceOverrides, type Services } from './services';
import { AppError, normalizeError } from './utils/errors';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const symbolParam = z.object({ symbol: z.string().min(2).max(20) });
const idParam = z.object({ id: z.string().uuid() });
const MAX_PCM_BYTES = 16_000 * 2 * 20; // 20 seconds of 16 kHz 16-bit mono

export interface BuiltApp {
  app: FastifyInstance;
  services: Services;
}

export async function buildApp(env: Env, overrides: ServiceOverrides = {}): Promise<BuiltApp> {
  const app = Fastify({
    bodyLimit: 64 * 1024,
    // Behind a host's proxy, rate limits must apply to the caller's address, not the proxy's (one hop).
    ...(env.NODE_ENV === 'production' ? { trustProxy: (_address: string, hop: number) => hop < 1 } : {}),
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    logger: {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers["x-mbx-apikey"]', 'req.headers.cookie', 'req.headers["idempotency-key"]'],
      ...(env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
        : {}),
    },
  });
  const services = createServices(env, overrides, app.log);

  await app.register(helmet);
  await app.register(cors, {
    // "*" is for a hosted backend serving the packaged app: auth is a bearer token, no cookies are used.
    origin: env.CORS_ORIGIN.includes('*') ? '*' : env.CORS_ORIGIN,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Idempotent-Replay'],
    maxAge: 86400,
  });
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_PCM_BYTES }, (_req, body, done) => done(null, body));

  const meta = (req: FastifyRequest) => ({ timestamp: new Date().toISOString(), requestId: req.id, mode: services.mode });
  const ok = <T>(req: FastifyRequest, data: T) => ({ success: true as const, data, meta: meta(req) });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('cache-control', 'no-store');
  });
  app.addHook('onResponse', async (req, reply) => {
    req.log.info({ route: req.routeOptions?.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'request completed');
  });

  app.setErrorHandler((err, req, reply) => {
    const n = normalizeError(err);
    if (n.status >= 500 && n.status !== 501) {
      const cause = err instanceof Error ? (err.cause as { code?: string; message?: string; name?: string } | undefined) : undefined;
      req.log.error({
        err: err instanceof Error ? { name: err.name, message: err.message.split('\n')[0] } : 'unknown',
        cause: cause ? { name: cause.name, code: cause.code, message: cause.message?.split('\n')[0] } : undefined, code: n.code,
      }, 'request failed');
    }
    else req.log.info({ code: n.code, status: n.status }, 'request rejected');
    return reply.code(n.status).send({ success: false, error: { code: n.code, message: n.message, ...(n.details !== undefined ? { details: n.details } : {}) } });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } }));

  const requireAuth = async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const ctx = token ? await services.auth.authenticate(token) : null;
    if (!ctx) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in again (pairing required).');
    req.auth = ctx;
  };
  const uid = (req: FastifyRequest) => req.auth!.userId;
  const protectedRoute = { preHandler: requireAuth };

  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  await app.register(
    async (v1) => {
      // ------------------------------------------------------------ health & diagnostics
      v1.get('/health', async (req) => {
        const [db, ex] = await Promise.allSettled([withTimeout(services.dbPing(), 4000), withTimeout(services.exchange.getServerTime(), 4000)]);
        const data: Health = {
          status: db.status === 'fulfilled' && ex.status === 'fulfilled' ? 'ok' : 'degraded',
          database: db.status === 'fulfilled' ? 'connected' : 'unavailable',
          exchange: ex.status === 'fulfilled' ? 'available' : 'unavailable',
          environment: 'testnet',
        };
        return ok(req, data);
      });

      v1.get('/diagnostics', protectedRoute, async (req) => {
        const time = async <T>(fn: () => Promise<T>) => {
          const t0 = Date.now();
          try {
            await withTimeout(fn(), 4000);
            return { up: true, ms: Date.now() - t0 };
          } catch {
            return { up: false, ms: null as number | null };
          }
        };
        const [db, ex] = await Promise.all([time(() => services.dbPing()), time(() => services.exchange.getServerTime())]);
        const data: Diagnostics = {
          database: { status: db.up ? 'connected' : 'unavailable', latencyMs: db.ms },
          exchange: {
            status: ex.up ? 'available' : 'unavailable', environment: 'testnet', latencyMs: ex.ms, mode: services.mode,
            lastUpdate: services.market.lastExchangeUpdate ? new Date(services.market.lastExchangeUpdate).toISOString() : null,
          },
          ai: { provider: services.ai.name, configured: services.ai.name !== 'deterministic' },
          stt: { provider: services.stt.name, configured: services.stt.isAvailable() },
          serverTime: new Date().toISOString(),
        };
        return ok(req, data);
      });

      // ------------------------------------------------------------ auth
      v1.post('/auth/pair', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
        const b = pairRequestSchema.parse(req.body);
        return ok(req, await services.auth.pair(b.pairingCode, b.deviceType, b.deviceIdentifier));
      });
      v1.post('/auth/refresh', protectedRoute, async (req) => ok(req, await services.auth.refresh(req.auth!)));
      v1.post('/auth/logout', protectedRoute, async (req) => {
        await services.auth.logout(req.auth!);
        return ok(req, { loggedOut: true });
      });
      v1.get('/auth/session', protectedRoute, async (req) =>
        ok(req, { expiresAt: req.auth!.expiresAt.toISOString(), user: { id: uid(req), displayName: req.auth!.displayName } }));

      // ------------------------------------------------------------ portfolio
      v1.get('/portfolio', protectedRoute, async (req) => ok(req, await services.portfolio.getPortfolio()));
      v1.get('/portfolio/balances', protectedRoute, async (req) => {
        const p = await services.portfolio.getPortfolio();
        return ok(req, { balances: p.balances, coverage: p.coverage, timestamp: p.timestamp, fresh: p.fresh });
      });
      v1.get('/portfolio/summary', protectedRoute, async (req) => {
        const p = await services.portfolio.getPortfolio();
        const { balances: _b, ...summary } = p;
        return ok(req, summary);
      });

      // ------------------------------------------------------------ market
      v1.get('/market/ticker/:symbol', protectedRoute, async (req) => ok(req, await services.market.getTicker(symbolParam.parse(req.params).symbol.toUpperCase())));
      v1.get('/market/stats/:symbol', protectedRoute, async (req) => ok(req, await services.market.getStats(symbolParam.parse(req.params).symbol.toUpperCase())));
      v1.get('/market/exchange-info/:symbol', protectedRoute, async (req) => ok(req, await services.market.requireSymbol(symbolParam.parse(req.params).symbol)));

      // ------------------------------------------------------------ watchlist
      v1.get('/watchlist', protectedRoute, async (req) => ok(req, await services.watchlist.list(uid(req))));
      v1.post('/watchlist/assets', protectedRoute, async (req) => {
        const { symbol } = addWatchlistSchema.parse(req.body);
        await services.watchlist.add(uid(req), symbol);
        return ok(req, await services.watchlist.list(uid(req)));
      });
      v1.delete('/watchlist/assets/:symbol', protectedRoute, async (req) => {
        await services.watchlist.remove(uid(req), symbolParam.parse(req.params).symbol);
        return ok(req, await services.watchlist.list(uid(req)));
      });

      // ------------------------------------------------------------ agent
      v1.post('/agent/sessions', protectedRoute, async (req) => ok(req, await services.agent.startSession(uid(req))));
      v1.get('/agent/sessions', protectedRoute, async (req) => ok(req, (await services.sessions.list(uid(req))).map(toSessionDto)));
      v1.get('/agent/sessions/:id', protectedRoute, async (req) => {
        const { id } = idParam.parse(req.params);
        const s = await services.sessions.get(uid(req), id);
        const messages = await services.sessions.messages(uid(req), id);
        return ok(req, { session: toSessionDto(s), messages: messages.map((m) => ({ id: m.id, role: m.role, content: m.content, intent: m.intent, createdAt: m.createdAt.toISOString() })) });
      });
      v1.post('/agent/sessions/:id/end', protectedRoute, async (req) => ok(req, await services.agent.endSession(uid(req), idParam.parse(req.params).id)));
      v1.post('/agent/message', { ...protectedRoute, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
        const b = agentMessageRequestSchema.parse(req.body);
        return ok(req, await services.agent.handleMessage(uid(req), b));
      });
      v1.post('/agent/transcribe', { ...protectedRoute, bodyLimit: MAX_PCM_BYTES, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
        if (!Buffer.isBuffer(req.body) || req.body.length < 3200) throw new AppError(400, 'VALIDATION_ERROR', 'Send raw 16 kHz 16-bit mono PCM (application/octet-stream), at least 100 ms.');
        if (req.body.length > MAX_PCM_BYTES) throw new AppError(413, 'AUDIO_TOO_LONG', 'Audio is too long.');
        const result = await services.stt.transcribe({ pcm: req.body, sampleRate: 16000 });
        return ok(req, { text: result.text, provider: services.stt.name });
      });

      // ------------------------------------------------------------ memory
      v1.get('/memory', protectedRoute, async (req) => ok(req, await services.memory.list(uid(req))));
      v1.post('/memory', protectedRoute, async (req) => {
        const b = createMemorySchema.parse(req.body);
        return ok(req, await services.memory.create(uid(req), { ...b, source: 'user_explicit' }));
      });
      v1.patch('/memory/:id', protectedRoute, async (req) =>
        ok(req, await services.memory.update(uid(req), idParam.parse(req.params).id, patchMemorySchema.parse(req.body))));
      v1.delete('/memory/:id', protectedRoute, async (req) => {
        await services.memory.remove(uid(req), idParam.parse(req.params).id);
        return ok(req, { deleted: true });
      });

      // ------------------------------------------------------------ trade plans (alerts + prepared orders; never auto-trade)
      v1.get('/plans', protectedRoute, async (req) => ok(req, await services.plans.listArmed(uid(req))));
      v1.post('/plans', protectedRoute, async (req) => ok(req, await services.plans.create(uid(req), createPlanSchema.parse(req.body))));
      v1.delete('/plans/:id', protectedRoute, async (req) => ok(req, await services.plans.cancel(uid(req), { id: idParam.parse(req.params).id })));
      v1.post('/plans/check', protectedRoute, async (req) =>
        ok(req, await services.plans.check(uid(req), z.object({ sessionId: z.string().uuid() }).parse(req.body).sessionId)));

      // ------------------------------------------------------------ trading
      v1.post('/trades/prepare', protectedRoute, async (req) => ok(req, await services.trading.prepare(uid(req), prepareTradeSchema.parse(req.body))));
      v1.get('/trades/proposals/:id', protectedRoute, async (req) => ok(req, await services.trading.getProposal(uid(req), idParam.parse(req.params).id)));
      v1.post('/trades/proposals/:id/approve', protectedRoute, async (req) =>
        ok(req, await services.trading.approve(uid(req), idParam.parse(req.params).id, approveTradeSchema.parse(req.body))));
      v1.post('/trades/proposals/:id/reject', protectedRoute, async (req) => {
        const body = z.object({ sessionId: z.string().uuid().optional() }).parse(req.body ?? {});
        return ok(req, await services.trading.reject(uid(req), idParam.parse(req.params).id, body.sessionId));
      });
      // The execute route accepts NO trade parameters: it can only run the already-approved, stored snapshot.
      v1.post('/trades/proposals/:id/execute', protectedRoute, async (req: FastifyRequest, reply: FastifyReply) => {
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string') throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'An Idempotency-Key header is required.');
        const { result, replay } = await services.trading.execute(uid(req), idParam.parse(req.params).id, key);
        if (replay) reply.header('idempotent-replay', 'true');
        return ok(req, result);
      });
      v1.get('/trades/orders', protectedRoute, async (req) => ok(req, await services.trading.listOrders(uid(req))));
      v1.get('/trades/orders/:id', protectedRoute, async (req) => ok(req, await services.trading.getOrder(uid(req), idParam.parse(req.params).id)));
      v1.post('/trades/orders/:id/cancel', protectedRoute, async (req) => ok(req, await services.trading.cancelOrder(uid(req), idParam.parse(req.params).id)));

      // ------------------------------------------------------------ demo reset (non-production only)
      v1.post('/demo/reset', protectedRoute, async (req) => {
        if (env.NODE_ENV === 'production') throw new AppError(403, 'FORBIDDEN', 'Not available in production.');
        const userId = uid(req);
        // Pending proposals are closed; exchange orders and their proposals are kept: exchange history is never "erased".
        const closed = await services.db.update(tradeProposals).set({ status: 'EXPIRED', failureReason: 'DEMO_RESET', updatedAt: new Date() })
          .where(and(eq(tradeProposals.userId, userId), eq(tradeProposals.status, 'PENDING_APPROVAL'))).returning({ id: tradeProposals.id });
        await services.db.delete(watchlists).where(eq(watchlists.userId, userId));
        await services.plans.cancel(userId);
        const removed = await services.db.delete(agentSessions).where(and(
          eq(agentSessions.userId, userId),
          notExists(services.db.select({ one: sql`1` }).from(tradeProposals).where(eq(tradeProposals.sessionId, agentSessions.id))),
        )).returning({ id: agentSessions.id });
        await services.audit.record({ userId, eventType: 'demo.reset', resourceType: 'user', resourceId: userId });
        return ok(req, { proposalsClosed: closed.length, sessionsRemoved: removed.length, watchlistReset: true });
      });
    },
    { prefix: '/api/v1' },
  );

  return { app, services };
}
