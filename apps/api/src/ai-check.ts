import { loadEnv } from './config/env';
import { createAIProvider } from './modules/ai/providers';
import { createSttProvider } from './modules/ai/stt';
import { AppError } from './utils/errors';

/**
 * `npm run ai:check` - verifies the optional LLM and speech-to-text keys with one tiny real call each.
 * Never prints a key. A provider that is not configured is reported as such (the product still works).
 */
async function main() {
  const env = loadEnv();
  let failed = false;

  console.log('--- LLM ---');
  console.log(`provider: ${env.AI_PROVIDER} | model: ${env.AI_MODEL ?? '(provider default)'} | key set: ${Boolean(env.AI_API_KEY)}`);
  const ai = createAIProvider(env);
  if (ai.name === 'deterministic') {
    console.log('NOT CONFIGURED -> deterministic fallback in use (set AI_PROVIDER + AI_API_KEY + AI_MODEL in apps/api/.env to enable).');
  } else {
    try {
      const r = await ai.generateInsight({
        question: 'Why is Bitcoin moving?', asset: 'BTC',
        context: { items: [{ ref: 'ticker:BTCUSDT', type: 'ticker', text: 'BTCUSDT last price 60,000.00 (testnet, 1s old).' }], memories: [], preferences: {} },
      });
      console.log(`OK (${ai.name}). grounded answer: "${r.response}" | facts: ${r.facts.length} | evidence: ${r.evidence.map((e) => e.reference).join(', ') || 'none'}`);
    } catch (err) {
      failed = true;
      console.log(`FAILED (${ai.name}): ${err instanceof Error ? err.message : 'unknown error'}`);
      console.log('  Check AI_API_KEY, AI_MODEL (must be a model your key can use) and, for OpenAI-compatible servers, AI_BASE_URL.');
    }
  }

  console.log('--- Speech-to-text ---');
  console.log(`provider: ${env.STT_PROVIDER} | model: ${env.STT_MODEL ?? '(default)'} | own key set: ${Boolean(env.STT_API_KEY)}`);
  const stt = createSttProvider(env);
  if (!stt.isAvailable()) {
    console.log('NOT CONFIGURED -> type your requests in the app panel (set STT_PROVIDER=openai plus a key to enable voice).');
  } else {
    try {
      // One second of silence: a valid key answers with "nothing heard" (STT_EMPTY); a bad key is rejected.
      await stt.transcribe({ pcm: Buffer.alloc(32_000), sampleRate: 16000 });
      console.log(`OK (${stt.name}): the service accepted the audio.`);
    } catch (err) {
      if (err instanceof AppError && err.code === 'STT_EMPTY') {
        console.log(`OK (${stt.name}): key accepted (silence correctly transcribed as nothing).`);
      } else {
        failed = true;
        const status = err instanceof AppError ? (err.details as { status?: number } | undefined)?.status : undefined;
        console.log(`FAILED (${stt.name}): ${err instanceof Error ? err.message : 'unknown error'}${status ? ` (HTTP ${status})` : ''}`);
      }
    }
  }
  process.exit(failed ? 1 : 0);
}

void main();
