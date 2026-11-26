import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { agentMessages, agentSessions, tradeProposals } from '../../db/schema';
import { outcomeWord } from '../trading/state-machine';
import { AppError } from '../../utils/errors';

export interface SessionRow {
  id: string;
  userId: string;
  startedAt: Date;
  endedAt: Date | null;
  summary: string | null;
  status: string;
}

export const toSessionDto = (s: SessionRow) => ({
  id: s.id, startedAt: s.startedAt.toISOString(), endedAt: s.endedAt?.toISOString() ?? null, summary: s.summary, status: s.status,
});

export class AgentSessionService {
  constructor(private readonly db: Db) {}

  async create(userId: string): Promise<SessionRow> {
    const [row] = await this.db.insert(agentSessions).values({ userId }).returning();
    return row!;
  }

  async list(userId: string, limit = 20): Promise<SessionRow[]> {
    return this.db.select().from(agentSessions).where(eq(agentSessions.userId, userId)).orderBy(desc(agentSessions.startedAt)).limit(limit);
  }

  /** Ownership check: another user's session id behaves exactly like a missing one. */
  async get(userId: string, id: string): Promise<SessionRow> {
    const [row] = await this.db.select().from(agentSessions).where(and(eq(agentSessions.id, id), eq(agentSessions.userId, userId))).limit(1);
    if (!row) throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    return row;
  }

  async requireActive(userId: string, id: string): Promise<SessionRow> {
    const s = await this.get(userId, id);
    if (s.status !== 'active') throw new AppError(409, 'SESSION_ENDED', 'This session has ended. Start a new one.');
    return s;
  }

  async lastEnded(userId: string): Promise<SessionRow | null> {
    const [row] = await this.db
      .select().from(agentSessions)
      .where(and(eq(agentSessions.userId, userId), eq(agentSessions.status, 'ended')))
      .orderBy(desc(agentSessions.endedAt)).limit(1);
    return row ?? null;
  }

  async addMessage(sessionId: string, role: 'user' | 'assistant', content: string, intent?: string, metadata: Record<string, unknown> = {}, createdAt?: Date) {
    await this.db.insert(agentMessages).values({ sessionId, role, content, intent: intent ?? null, metadata, ...(createdAt ? { createdAt } : {}) });
  }

  async messages(userId: string, sessionId: string, limit = 100) {
    await this.get(userId, sessionId);
    return this.db.select().from(agentMessages).where(eq(agentMessages.sessionId, sessionId)).orderBy(agentMessages.createdAt).limit(limit);
  }

  /** Deterministic session summary: what was asked and what was traded. No model involved. */
  async end(userId: string, id: string): Promise<SessionRow> {
    const s = await this.get(userId, id);
    if (s.status === 'ended') return s;
    const msgs = await this.db.select().from(agentMessages).where(eq(agentMessages.sessionId, id));
    const userMsgs = msgs.filter((m) => m.role === 'user');
    const symbols = new Set<string>();
    for (const m of userMsgs) {
      const syms = (m.metadata as { symbols?: string[] } | null)?.symbols;
      syms?.forEach((x) => symbols.add(x));
    }
    const trades = await this.db
      .select({ status: tradeProposals.status, reason: tradeProposals.failureReason, n: sql<number>`count(*)::int` })
      .from(tradeProposals).where(eq(tradeProposals.sessionId, id)).groupBy(tradeProposals.status, tradeProposals.failureReason);
    const outcomes = new Map<string, number>();
    for (const t of trades) {
      const word = outcomeWord(t.status, t.reason);
      outcomes.set(word, (outcomes.get(word) ?? 0) + t.n);
    }
    const tradeText = outcomes.size ? `Trades: ${[...outcomes].map(([word, n]) => `${n} ${word}`).join(', ')}.` : '';
    // Short enough for the glasses: it is read back in the next session's greeting.
    const assets = [...symbols].slice(0, 4).map((x) => x.replace(/(USDT|USDC)$/, ''));
    const summary = `${tradeText || 'No trades.'}${assets.length ? ` Assets: ${assets.join(', ')}.` : ''}`;
    const [row] = await this.db
      .update(agentSessions).set({ status: 'ended', endedAt: new Date(), summary })
      .where(and(eq(agentSessions.id, id), eq(agentSessions.status, 'active'))).returning();
    return row ?? (await this.get(userId, id));
  }
}
