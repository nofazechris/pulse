import { loadEnv } from '../config/env';
import { pingDatabase } from './client';

/**
 * `npm run db:check` - runs one query against Neon. Never prints the connection string.
 * `npm run db:latency` - also times 10 sequential round trips (useful to judge the region).
 */
async function main() {
  const env = loadEnv();
  if (!env.DATABASE_URL) {
    console.error(
      'DATABASE_URL is not set.\n' +
        '  1. Copy apps/api/.env.example to apps/api/.env\n' +
        '  2. Paste your Neon pooled connection string after DATABASE_URL=\n' +
        '     (Neon Console -> Connect -> choose branch/role/database)\n' +
        '  3. Re-run: npm run db:check',
    );
    process.exit(2);
  }
  try {
    const r = await pingDatabase(env.DATABASE_URL);
    console.log(`Neon OK: database "${r.database}", server time ${r.serverTime}`);
    if (process.argv.includes('--latency')) {
      const ms: number[] = [];
      let failures = 0;
      for (let i = 0; i < 10; i++) {
        const t = performance.now();
        try {
          await pingDatabase(env.DATABASE_URL);
          ms.push(Math.round(performance.now() - t));
        } catch {
          failures++;
        }
      }
      const sorted = [...ms].sort((a, b) => a - b);
      console.log(`latency over 10 queries: ${ms.join(', ')} ms (median ${sorted[Math.floor(sorted.length / 2)] ?? '-'} ms, failures ${failures})`);
    }
  } catch (err) {
    // Message only; the driver error could echo connection details in odd cases.
    console.error(`Neon query failed: ${err instanceof Error ? err.message.split('\n')[0] : 'unknown error'}`);
    process.exit(1);
  }
}

void main();
