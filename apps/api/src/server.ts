import { buildApp } from './app';
import { loadEnv } from './config/env';

const env = loadEnv();
const { app, services } = await buildApp(env);

app.log.info({ mode: services.mode, exchange: services.exchange.name, ai: services.ai.name, stt: services.stt.name, environment: 'testnet' }, 'PULSE API starting');

try {
  await app.listen({ host: env.HOST, port: env.API_PORT });
  // Watch armed trade plans even while no app is open. It only records that a level was reached.
  const stopWatching = services.plans.startWatching((err) => app.log.warn({ err: err instanceof Error ? err.message : 'unknown' }, 'plan watcher failed'));
  // Hosts stop a service with SIGTERM: finish in-flight requests (an order submission must not be cut off).
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      stopWatching();
      app.close().then(() => process.exit(0), () => process.exit(1));
    });
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
