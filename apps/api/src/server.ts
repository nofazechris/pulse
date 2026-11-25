import { buildApp } from './app';
import { loadEnv } from './config/env';

const env = loadEnv();
const { app, services } = await buildApp(env);

app.log.info({ mode: services.mode, exchange: services.exchange.name, ai: services.ai.name, stt: services.stt.name, environment: 'testnet' }, 'PULSE API starting');

try {
  await app.listen({ host: env.HOST, port: env.API_PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
