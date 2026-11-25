import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { eq, inArray } from 'drizzle-orm';
import { buildApp } from '../src/app';
import { parseEnv, type Env } from '../src/config/env';
import { createDb } from '../src/db/client';
import { auditLogs, users } from '../src/db/schema';
import { FakeExchangeAdapter } from '../src/modules/exchange/fake-adapter';
import type { AIProvider } from '../src/modules/ai/types';
import type { ExchangeAdapter } from '../src/modules/exchange/types';

config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

export const HAS_DB = Boolean(process.env.DATABASE_URL);

export function testEnv(extra: Record<string, string> = {}): Env {
  return parseEnv({
    ...process.env,
    NODE_ENV: 'test', LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent', DEMO_MODE: 'false', PAIRING_CODE: 'unit-test-pairing-code',
    AI_PROVIDER: '', STT_PROVIDER: '', PROPOSAL_TTL_SECONDS: '120', ...extra,
  });
}

export interface TestUser { id: string; token: string; headers: Record<string, string> }

export async function createHarness(opts: { ai?: AIProvider; env?: Record<string, string>; exchange?: ExchangeAdapter } = {}) {
  const env = testEnv(opts.env);
  const fake = new FakeExchangeAdapter();
  const { app, services } = await buildApp(env, { exchange: opts.exchange ?? fake, ...(opts.ai ? { ai: opts.ai } : {}) });
  const db = createDb(env.DATABASE_URL!).db;
  const created: string[] = [];

  async function createUser(): Promise<TestUser> {
    const [u] = await db.insert(users).values({ email: `test-${randomUUID()}@pulse.test`, displayName: 'Test User' }).returning();
    created.push(u!.id);
    const s = await services.auth.issue(u!.id, 'web');
    return { id: u!.id, token: s.accessToken, headers: { authorization: `Bearer ${s.accessToken}` } };
  }

  async function call<T = any>(user: TestUser | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
    const res = await app.inject({ method, url: `/api/v1${url}`, ...(payload !== undefined ? { payload: payload as object } : {}), headers: { ...(user?.headers ?? {}), ...headers } });
    return { status: res.statusCode, body: res.json() as { success: boolean; data: T; error: { code: string; message: string; details?: any } }, headers: res.headers };
  }

  function resetFake() {
    const fresh = new FakeExchangeAdapter();
    fake.prices = fresh.prices; fake.balances = fresh.balances; fake.orders = fresh.orders;
    fake.failure = null; fake.down = false; fake.getOrderDown = false; fake.createOrderCalls = 0;
    services.market.invalidate();
    services.portfolio.invalidate();
  }

  async function cleanup() {
    await services.audit.flush();
    if (created.length) {
      await db.delete(auditLogs).where(inArray(auditLogs.userId, created));
      await db.delete(users).where(inArray(users.id, created)); // cascades to every child row
    }
    await app.close();
  }

  async function startSession(user: TestUser): Promise<string> {
    const r = await call<{ session: { id: string } }>(user, 'POST', '/agent/sessions');
    return r.body.data.session.id;
  }

  /** prepare -> returns proposal. */
  async function prepare(user: TestUser, sessionId: string, over: Record<string, unknown> = {}) {
    return call<any>(user, 'POST', '/trades/prepare', { sessionId, symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quoteOrderQty: '50', ...over });
  }

  async function approve(user: TestUser, proposal: { id: string; proposalHash: string }, sessionId: string, hash = proposal.proposalHash) {
    return call<any>(user, 'POST', `/trades/proposals/${proposal.id}/approve`, { sessionId, proposalHash: hash, method: 'glasses_gesture' });
  }

  const execute = (user: TestUser, id: string, key = `key-${randomUUID()}`) =>
    call<any>(user, 'POST', `/trades/proposals/${id}/execute`, undefined, { 'idempotency-key': key });

  return { env, app, services, fake, db, createUser, call, resetFake, cleanup, startSession, prepare, approve, execute, eq };
}
export type Harness = Awaited<ReturnType<typeof createHarness>>;


