import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { NonTestnetUrlError, assertTestnetRestUrl, assertTestnetStreamUrl } from '../modules/exchange/guard';

const blankToUndefined = (v: string | undefined) => (v && v.trim() !== '' ? v.trim() : undefined);
const optional = z.string().optional().transform(blankToUndefined);
const bool = z
  .string()
  .optional()
  .transform((v) => (v ?? '').trim().toLowerCase() === 'true');

const TEST_SESSION_SECRET = 'test-only-session-secret-0123456789abcdef0123456789';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    API_BASE_URL: z.string().default('http://localhost:8787'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    CORS_ORIGIN: z
      .string()
      .default('http://localhost:5180')
      .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

    DATABASE_URL: optional.refine((v) => v === undefined || /^postgres(ql)?:\/\//.test(v), {
      message: 'DATABASE_URL must start with postgresql://',
    }),
    DATABASE_DIRECT_URL: optional,

    // There is intentionally no way to select anything but the testnet.
    BINANCE_ENV: z.literal('testnet').default('testnet'),
    BINANCE_TESTNET_REST_URL: z.string().default('https://testnet.binance.vision/api'),
    BINANCE_TESTNET_STREAM_URL: z.string().default('wss://stream.testnet.binance.vision/stream'),
    BINANCE_API_KEY: optional,
    BINANCE_API_SECRET: optional,

    AI_PROVIDER: optional.pipe(z.enum(['none', 'anthropic', 'openai']).optional()),
    AI_API_KEY: optional,
    AI_MODEL: optional,
    AI_BASE_URL: optional,
    STT_PROVIDER: optional.pipe(z.enum(['none', 'openai']).optional()),
    STT_API_KEY: optional,
    STT_MODEL: optional,
    STT_BASE_URL: optional,

    SESSION_SECRET: optional,
    SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(120),
    PAIRING_CODE: optional,

    PROPOSAL_TTL_SECONDS: z.coerce.number().int().min(15).max(900).default(120),
    PRICE_MOVE_TOLERANCE_PERCENT: z.coerce.number().min(0.01).max(10).default(1),

    /** Explicit demo mode: uses a deterministic fake exchange and labels every response DEMO. */
    DEMO_MODE: bool,
  })
  .superRefine((env, ctx) => {
    try {
      assertTestnetRestUrl(env.BINANCE_TESTNET_REST_URL);
      assertTestnetStreamUrl(env.BINANCE_TESTNET_STREAM_URL);
    } catch (e) {
      ctx.addIssue({ code: 'custom', path: ['BINANCE_TESTNET_REST_URL'], message: e instanceof NonTestnetUrlError ? e.message : 'Invalid Binance URL' });
    }
    if (env.NODE_ENV !== 'test') {
      if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
        ctx.addIssue({ code: 'custom', path: ['SESSION_SECRET'], message: 'SESSION_SECRET (>= 32 chars) is required' });
      }
    }
    if (env.PAIRING_CODE !== undefined && env.PAIRING_CODE.length < 8) {
      ctx.addIssue({ code: 'custom', path: ['PAIRING_CODE'], message: 'PAIRING_CODE must be at least 8 characters' });
    }
  })
  .transform((env) => ({
    ...env,
    SESSION_SECRET: env.SESSION_SECRET ?? TEST_SESSION_SECRET,
    BINANCE_TESTNET_REST_URL: assertTestnetRestUrl(env.BINANCE_TESTNET_REST_URL),
    BINANCE_TESTNET_STREAM_URL: assertTestnetStreamUrl(env.BINANCE_TESTNET_STREAM_URL),
    AI_PROVIDER: env.AI_PROVIDER ?? ('none' as const),
    STT_PROVIDER: env.STT_PROVIDER ?? ('none' as const),
  }));

export type Env = z.infer<typeof envSchema>;

/** Parse an env source. Error messages never include the offending values (they may be secrets). */
export function parseEnv(source: Record<string, string | undefined>): Env {
  // Hosting platforms announce the port to listen on as PORT.
  const result = envSchema.safeParse(source.PORT && !source.API_PORT ? { ...source, API_PORT: source.PORT } : source);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}

/** Load apps/api/.env (if present) and parse process.env. */
export function loadEnv(): Env {
  loadDotenv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });
  return parseEnv(process.env);
}
