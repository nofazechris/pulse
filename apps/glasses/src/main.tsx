import { createRoot } from 'react-dom/client';
import { App } from './App';
import { EvenHubAdapter } from './sdk/EvenHubAdapter';
import { SimulatorAdapter } from './sdk/SimulatorAdapter';
import type { GlassesAdapter } from './sdk/types';
import { ApiClient } from './services/api';
import { createTokenStore } from './services/tokenStore';
import { PulseController } from './state/controller';
import './styles.css';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';
// Dev convenience only: .env.development.local is loaded by `vite dev`, never by `vite build`.
const AUTO_PAIR = import.meta.env.DEV ? import.meta.env.VITE_DEMO_PAIRING_CODE : undefined;

async function boot() {
  const tokens = createTokenStore();
  const api = new ApiClient({ baseUrl: API_URL, getToken: () => tokens.get()?.token ?? null });

  let adapter: GlassesAdapter;
  let bridgeNote: string;
  try {
    const a = new EvenHubAdapter();
    await a.initialize();
    adapter = a;
    bridgeNote = 'Even Hub bridge connected';
  } catch (err) {
    adapter = new SimulatorAdapter();
    bridgeNote = `No Even Hub bridge (${err instanceof Error ? err.message : 'unknown'}). Using in-memory adapter.`;
  }

  const controller = new PulseController({
    adapter, api, tokens, autoPairCode: AUTO_PAIR, deviceType: adapter.kind === 'even-hub' ? 'simulator' : 'web',
  });
  createRoot(document.getElementById('root')!).render(<App controller={controller} api={api} apiUrl={API_URL} adapterKind={adapter.kind} bridgeNote={bridgeNote} />);
  await controller.start();
}

void boot();
