import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

config({ path: fileURLToPath(new URL('./.env', import.meta.url)), quiet: true });

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    // Prefer a DIRECT (non-pooler) URL for migrations if you have one: DATABASE_DIRECT_URL.
    url: process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL ?? '',
  },
});

