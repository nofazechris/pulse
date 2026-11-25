import { neon, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { Agent, fetch as undiciFetch } from 'undici';
import * as schema from './schema';

/**
 * Retries ONLY read-only queries on transient transport failures (dropped connection, 5xx).
 * Writes are never retried here: a lost response may hide a committed write.
 */
export function isReadOnlyQueryBody(body: unknown): boolean {
  if (typeof body !== 'string') return false;
  try {
    const parsed = JSON.parse(body) as { query?: unknown; queries?: unknown[] };
    const first = typeof parsed.query === 'string' ? parsed.query : undefined;
    return first !== undefined && /^\s*select\b/i.test(first);
  } catch {
    return false;
  }
}

/**
 * Neon's HTTP endpoint is far away from some networks. Node's default pool closes idle sockets after ~4 s
 * (so most requests paid a new TCP+TLS connect, and some hit the default 10 s connect timeout). A dedicated
 * keep-alive pool reuses connections and fails a stuck connect fast so it can be retried.
 */
const agent = new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 300_000,
  connections: 8,
  connect: { timeout: 5_000 },
});
const baseFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
  undiciFetch(input as never, { ...(init as object), dispatcher: agent } as never)) as unknown as typeof fetch;
const DB_TIMEOUT_MS = 15_000;
/** Errors where the request provably never left this machine: safe to retry even a write. */
const NEVER_SENT = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
const causeCode = (err: unknown): string | undefined => {
  const c = (err as { cause?: { code?: string } } | undefined)?.cause;
  return c?.code ?? (err as { code?: string } | undefined)?.code;
};

export const retryingFetch: typeof fetch = async (input, init) => {
  const readOnly = isReadOnlyQueryBody(init?.body);
  const attempts = 3;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(DB_TIMEOUT_MS)]) : AbortSignal.timeout(DB_TIMEOUT_MS);
    try {
      const res = await baseFetch(input, { ...init, signal });
      if (readOnly && res.status >= 500 && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 150 * (i + 1)));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      const code = causeCode(err) ?? (err as Error)?.name;
      if (process.env.PULSE_DB_DEBUG) console.error(`[db] fetch failed attempt ${i + 1}/${attempts} readOnly=${readOnly} code=${code}`);
      // Reads can always be retried. Writes only when the request never reached Neon (a lost response may hide a commit).
      const safe = readOnly || (typeof causeCode(err) === 'string' && NEVER_SENT.has(causeCode(err)!));
      if (!safe || i >= attempts - 1) break;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
  throw lastErr;
};
neonConfig.fetchFunction = retryingFetch;

/**
 * Drizzle over Neon's HTTP driver. It is stateless and does not support interactive transactions,
 * so every state change in PULSE is a single atomic compare-and-set statement
 * (UPDATE ... WHERE status = <expected> RETURNING) or a unique-index-guarded INSERT.
 */
export function createDb(databaseUrl: string) {
  const sql = neon(databaseUrl);
  return { sql, db: drizzle(sql, { schema }) };
}

export type Db = ReturnType<typeof createDb>['db'];
export { schema };

export interface DbPingResult {
  database: string;
  serverTime: string;
}

/** Smallest possible round trip: proves credentials, network and TLS work. */
export async function pingDatabase(databaseUrl: string): Promise<DbPingResult> {
  const { sql } = createDb(databaseUrl);
  const rows = await sql`SELECT current_database() AS database, now()::text AS server_time`;
  const row = rows[0] as { database: string; server_time: string } | undefined;
  if (!row) throw new Error('Database ping returned no rows');
  return { database: row.database, serverTime: row.server_time };
}
