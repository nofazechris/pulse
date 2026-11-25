import { auditLogs } from '../db/schema';
import type { Db } from '../db/client';

const SENSITIVE_KEY = /secret|signature|token|authorization|api[-_]?key|password|cookie|pairing/i;

/** Recursively drops credential-looking keys so audit rows can never carry secrets. */
export function sanitizeMetadata(input: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]';
  if (Array.isArray(input)) return input.slice(0, 50).map((v) => sanitizeMetadata(v, depth + 1));
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : sanitizeMetadata(v, depth + 1);
    }
    return out;
  }
  if (typeof input === 'string' && input.length > 500) return `${input.slice(0, 500)}...`;
  return input;
}

export interface AuditEvent {
  userId?: string | null;
  sessionId?: string | null;
  eventType: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}

export class AuditService {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly db: Db, private readonly onError?: (err: unknown) => void) {}

  /** Non-blocking write for latency-sensitive paths (each DB round trip costs real time on Neon HTTP). */
  fire(e: AuditEvent): void {
    const p: Promise<void> = this.record(e).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Waits for all fire-and-forget writes (used on shutdown and in tests). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  /** Audit failures must never break the user flow, but are surfaced to the logger. */
  async record(e: AuditEvent): Promise<void> {
    try {
      await this.db.insert(auditLogs).values({
        userId: e.userId ?? null,
        sessionId: e.sessionId ?? null,
        eventType: e.eventType,
        resourceType: e.resourceType,
        resourceId: e.resourceId ?? null,
        metadata: sanitizeMetadata(e.metadata ?? {}) as Record<string, unknown>,
      });
    } catch (err) {
      this.onError?.(err);
    }
  }
}
