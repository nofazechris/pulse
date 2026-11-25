import { and, desc, eq, isNull, or, gt } from 'drizzle-orm';
import type { Memory } from '@pulse/shared';
import type { Db } from '../../db/client';
import { userMemories, userPreferences } from '../../db/schema';
import { AppError } from '../../utils/errors';

type Row = typeof userMemories.$inferSelect;
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'what', 'about', 'how', 'why', 'are', 'you', 'can', 'please', 'show', 'tell', 'have', 'does', 'did', 'was', 'from', 'pulse']);

export const toMemoryDto = (r: Row): Memory => ({
  id: r.id, category: r.category as Memory['category'], content: r.content, source: r.source,
  verification: r.verification as Memory['verification'], confidence: r.confidence,
  createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), expiresAt: r.expiresAt?.toISOString() ?? null,
});

const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));

/** Pure relevance scoring: keyword overlap, boosted for stable categories, with a mild recency tie-break. */
export function scoreMemories<T extends { content: string; category: string; updatedAt: Date }>(items: T[], query: string, limit = 5): T[] {
  const q = new Set(tokens(query));
  const base: Record<string, number> = { explicit_preference: 1, financial_goal: 1, interaction_preference: 1.5, temporary_context: 0.3, session_summary: 0 };
  return items
    .map((m) => {
      const overlap = tokens(m.content).filter((w) => q.has(w)).length;
      const score = (base[m.category] ?? 0.5) + overlap * 2 + m.updatedAt.getTime() / 1e15;
      return { m, score, overlap };
    })
    .filter((x) => x.m.category !== 'session_summary' && (x.overlap > 0 || (base[x.m.category] ?? 0) >= 1))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.m);
}

export class MemoryService {
  constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {}

  private active(userId: string) {
    return and(eq(userMemories.userId, userId), or(isNull(userMemories.expiresAt), gt(userMemories.expiresAt, this.now())));
  }

  async list(userId: string): Promise<Memory[]> {
    const rows = await this.db.select().from(userMemories).where(this.active(userId)).orderBy(desc(userMemories.updatedAt)).limit(200);
    return rows.map(toMemoryDto);
  }

  async create(userId: string, input: { category: Memory['category']; content: string; source?: string; verification?: Memory['verification']; expiresAt?: Date }): Promise<Memory> {
    const content = input.content.trim();
    if (!content) throw new AppError(400, 'VALIDATION_ERROR', 'Memory content cannot be empty.');
    // Never store anything credential-shaped in conversational memory.
    if (/(api[ _-]?key|secret|password|private key|seed phrase|token)\b/i.test(content)) {
      throw new AppError(422, 'MEMORY_REJECTED', 'For your safety, PULSE does not store keys, passwords or secrets.');
    }
    const [row] = await this.db.insert(userMemories).values({
      userId, category: input.category, content, source: input.source ?? 'user_explicit',
      verification: input.verification ?? 'user_confirmed', expiresAt: input.expiresAt ?? null,
    }).returning();
    return toMemoryDto(row!);
  }

  async update(userId: string, id: string, patch: { content?: string; category?: Memory['category'] }): Promise<Memory> {
    const set: Partial<typeof userMemories.$inferInsert> = { updatedAt: this.now() };
    if (patch.content !== undefined) set.content = patch.content.trim();
    if (patch.category) set.category = patch.category;
    const [row] = await this.db.update(userMemories).set(set).where(and(eq(userMemories.id, id), eq(userMemories.userId, userId))).returning();
    if (!row) throw new AppError(404, 'MEMORY_NOT_FOUND', 'Memory not found.');
    return toMemoryDto(row);
  }

  async remove(userId: string, id: string): Promise<void> {
    const rows = await this.db.delete(userMemories).where(and(eq(userMemories.id, id), eq(userMemories.userId, userId))).returning({ id: userMemories.id });
    if (rows.length === 0) throw new AppError(404, 'MEMORY_NOT_FOUND', 'Memory not found.');
  }

  /** At most `limit` relevant memories for one request. The full history is never sent to a model. */
  async retrieve(userId: string, query: string, limit = 5): Promise<Memory[]> {
    const rows = await this.db.select().from(userMemories).where(this.active(userId)).orderBy(desc(userMemories.updatedAt)).limit(100);
    return scoreMemories(rows, query, limit).map(toMemoryDto);
  }

  async setPreference(userId: string, key: string, value: unknown): Promise<void> {
    await this.db.insert(userPreferences).values({ userId, preferenceKey: key, preferenceValue: value as never })
      .onConflictDoUpdate({ target: [userPreferences.userId, userPreferences.preferenceKey], set: { preferenceValue: value as never, updatedAt: this.now() } });
  }

  async preferences(userId: string): Promise<Record<string, unknown>> {
    const rows = await this.db.select().from(userPreferences).where(eq(userPreferences.userId, userId));
    return Object.fromEntries(rows.map((r) => [r.preferenceKey, r.preferenceValue]));
  }

  async saveSessionSummary(userId: string, summary: string): Promise<void> {
    await this.db.insert(userMemories).values({
      userId, category: 'session_summary', content: summary, source: 'system', verification: 'system_derived',
      expiresAt: new Date(this.now().getTime() + 30 * 86400_000),
    });
  }
}
