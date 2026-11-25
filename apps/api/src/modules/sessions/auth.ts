import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { AuthSession } from '@pulse/shared';
import type { Env } from '../../config/env';
import type { Db } from '../../db/client';
import { deviceSessions, users } from '../../db/schema';
import type { AuditService } from '../../security/audit';
import { AppError } from '../../utils/errors';

export interface AuthContext {
  userId: string;
  deviceSessionId: string;
  displayName: string | null;
  expiresAt: Date;
}

const DEMO_EMAIL = 'demo@pulse.local';
const TOUCH_INTERVAL_MS = 60_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/**
 * Lightweight backend-controlled device pairing (NOT production-grade identity): a pairing code held in
 * server env links a device to the single demo user and mints a short-lived opaque token. Only an HMAC of
 * the token is stored. See docs/SECURITY.md for the documented limitations.
 */
export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly env: Env,
    private readonly audit: AuditService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  hashToken(token: string): string {
    return createHmac('sha256', this.env.SESSION_SECRET).update(token).digest('hex');
  }

  private codeMatches(code: string): boolean {
    const expected = this.env.PAIRING_CODE;
    if (!expected) return false;
    return timingSafeEqual(sha256(code), sha256(expected));
  }

  async pair(code: string, deviceType: string, deviceIdentifier?: string): Promise<AuthSession> {
    if (!this.env.PAIRING_CODE) {
      throw new AppError(503, 'PAIRING_DISABLED', 'Device pairing is not configured on the server.');
    }
    if (!this.codeMatches(code)) {
      await this.audit.record({ eventType: 'auth.pair_failed', resourceType: 'device_session', metadata: { deviceType } });
      throw new AppError(401, 'INVALID_PAIRING_CODE', 'That pairing code is not valid.');
    }
    const userId = await this.ensureDemoUser();
    const session = await this.issue(userId, deviceType, deviceIdentifier);
    this.audit.fire({ userId, eventType: 'auth.paired', resourceType: 'device_session', metadata: { deviceType } });
    return session;
  }

  private async ensureDemoUser(): Promise<string> {
    await this.db
      .insert(users)
      .values({ email: DEMO_EMAIL, displayName: 'PULSE Demo Trader' })
      .onConflictDoNothing({ target: users.email });
    const [u] = await this.db.select({ id: users.id }).from(users).where(eq(users.email, DEMO_EMAIL)).limit(1);
    if (!u) throw new AppError(500, 'INTERNAL_ERROR', 'Could not provision the demo user.');
    return u.id;
  }

  /** Mints a device session for an existing user (also used by tests). */
  async issue(userId: string, deviceType: string, deviceIdentifier?: string): Promise<AuthSession> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user || user.status !== 'active') throw new AppError(403, 'USER_INACTIVE', 'This account is not active.');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + this.env.SESSION_TTL_MINUTES * 60_000);
    await this.db.insert(deviceSessions).values({
      userId, deviceType, deviceIdentifier: deviceIdentifier ?? null, sessionTokenHash: this.hashToken(token), expiresAt,
    });
    return { accessToken: token, expiresAt: expiresAt.toISOString(), user: { id: user.id, displayName: user.displayName } };
  }

  /** Short in-process cache: every uncached request would otherwise pay a full Neon round trip. Logout/refresh evict it. */
  private readonly cache = new Map<string, { ctx: AuthContext; at: number }>();
  private static readonly CACHE_TTL_MS = 15_000;

  private evict(deviceSessionId: string) {
    for (const [k, v] of this.cache) if (v.ctx.deviceSessionId === deviceSessionId) this.cache.delete(k);
  }

  async authenticate(token: string): Promise<AuthContext | null> {
    if (!token || token.length > 256) return null;
    const now = this.now();
    const hash = this.hashToken(token);
    const hit = this.cache.get(hash);
    if (hit && now.getTime() - hit.at < AuthService.CACHE_TTL_MS && hit.ctx.expiresAt > now) return hit.ctx;
    this.cache.delete(hash);
    const ctx = await this.authenticateUncached(token, now);
    if (ctx) this.cache.set(hash, { ctx, at: now.getTime() });
    return ctx;
  }

  private async authenticateUncached(token: string, now: Date): Promise<AuthContext | null> {
    const rows = await this.db
      .select({
        id: deviceSessions.id, userId: deviceSessions.userId, expiresAt: deviceSessions.expiresAt,
        lastActiveAt: deviceSessions.lastActiveAt, displayName: users.displayName, status: users.status,
      })
      .from(deviceSessions)
      .innerJoin(users, eq(users.id, deviceSessions.userId))
      .where(and(eq(deviceSessions.sessionTokenHash, this.hashToken(token)), isNull(deviceSessions.revokedAt), gt(deviceSessions.expiresAt, now)))
      .limit(1);
    const s = rows[0];
    if (!s || s.status !== 'active') return null;
    if (now.getTime() - s.lastActiveAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.update(deviceSessions).set({ lastActiveAt: now }).where(eq(deviceSessions.id, s.id));
    }
    return { userId: s.userId, deviceSessionId: s.id, displayName: s.displayName, expiresAt: s.expiresAt };
  }

  /** Rotates the token of a still-valid session (the old token stops working immediately). */
  async refresh(ctx: AuthContext): Promise<AuthSession> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + this.env.SESSION_TTL_MINUTES * 60_000);
    const updated = await this.db
      .update(deviceSessions)
      .set({ sessionTokenHash: this.hashToken(token), expiresAt, lastActiveAt: this.now() })
      .where(and(eq(deviceSessions.id, ctx.deviceSessionId), isNull(deviceSessions.revokedAt)))
      .returning({ id: deviceSessions.id });
    this.evict(ctx.deviceSessionId);
    if (updated.length === 0) throw new AppError(401, 'UNAUTHENTICATED', 'Session is no longer valid.');
    this.audit.fire({ userId: ctx.userId, eventType: 'auth.refreshed', resourceType: 'device_session', resourceId: ctx.deviceSessionId });
    return { accessToken: token, expiresAt: expiresAt.toISOString(), user: { id: ctx.userId, displayName: ctx.displayName } };
  }

  async logout(ctx: AuthContext): Promise<void> {
    this.evict(ctx.deviceSessionId);
    await this.db.update(deviceSessions).set({ revokedAt: this.now() }).where(eq(deviceSessions.id, ctx.deviceSessionId));
    this.audit.fire({ userId: ctx.userId, eventType: 'auth.logout', resourceType: 'device_session', resourceId: ctx.deviceSessionId });
  }
}
