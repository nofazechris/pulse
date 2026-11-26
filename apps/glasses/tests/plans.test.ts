import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanAlert, TradePlan } from '@pulse/shared';
import { renderScreen } from '../src/screens';
import { SimulatorAdapter } from '../src/sdk/SimulatorAdapter';
import type { ApiClient } from '../src/services/api';
import { createTokenStore } from '../src/services/tokenStore';
import { PulseController } from '../src/state/controller';
import { executeResult, portfolio, proposal, reply, state, stats, watchlist } from './fixtures';

const SESSION = '00000000-0000-4000-8000-000000000003';
const plan: TradePlan = {
  id: '00000000-0000-4000-8000-0000000000b1', symbol: 'BTCUSDT', direction: 'BELOW', triggerPrice: '58800', referencePrice: '60000',
  side: 'BUY', quoteOrderQty: '20', quantity: null, status: 'TRIGGERED', createdAt: '', expiresAt: '', triggeredAt: '', observedPrice: '58750',
};
const withOrder: PlanAlert = { plan, proposal: proposal({ warnings: ['PLAN: BTC below 58,800.00 reached'] }), message: 'Plan fired: BTC below 58,800.00.' };
const newsOnly: PlanAlert = { plan: { ...plan, side: null, quoteOrderQty: null }, proposal: null, message: 'Plan fired: BTC below 58,800.00. Now 58,750.00.' };

function makeApi(armed: number, alert: PlanAlert | null) {
  let pending = alert;
  return {
    health: vi.fn(async () => ({ status: 'ok', database: 'connected', exchange: 'available', environment: 'testnet' })),
    pair: vi.fn(async () => ({ accessToken: 't', expiresAt: new Date(Date.now() + 3600_000).toISOString(), user: { id: 'u', displayName: 'x' } })),
    session: vi.fn(),
    startSession: vi.fn(async () => ({ session: { id: SESSION }, greeting: reply({ intent: 'START_SESSION' }) })),
    portfolio: vi.fn(async () => portfolio), watchlist: vi.fn(async () => watchlist), stats: vi.fn(async () => stats),
    plans: vi.fn(async () => Array.from({ length: armed }, () => plan)),
    checkPlans: vi.fn(async () => { const a = pending; pending = null; return { alerts: a ? [a] : [], armed: a ? armed - 1 : armed }; }),
    message: vi.fn(async () => reply()),
    approve: vi.fn(async () => proposal({ status: 'APPROVED' })), reject: vi.fn(async () => proposal({ status: 'REJECTED' })),
    execute: vi.fn(async () => executeResult()), newIdempotencyKey: () => 'pulse-key-000001',
  };
}

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };
let c: PulseController | undefined;
let adapter: SimulatorAdapter;
let clock = 5_000_000;
afterEach(async () => { await c?.dispose(); c = undefined; });

async function boot(api: ReturnType<typeof makeApi>) {
  adapter = new SimulatorAdapter();
  const m = new Map<string, string>();
  const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  c = new PulseController({ adapter, api: api as unknown as ApiClient, tokens: createTokenStore(storage), autoPairCode: 'code-1234', clock: () => clock });
  await c.start();
  await settle();
  return c;
}
const gesture = async (g: Parameters<SimulatorAdapter['emitGesture']>[0]) => { clock += 1000; adapter.emitGesture(g); await settle(); };

describe('trade plans on the glasses', () => {
  it('shows how many plans are armed, and does not poll when there are none', async () => {
    const none = makeApi(0, null);
    await boot(none);
    await c!.pollPlans(true);
    expect(none.checkPlans).not.toHaveBeenCalled();
    await c!.dispose();
    await boot(makeApi(2, null));
    expect(adapter.lastView?.footer).toContain('2 PLANS ARMED');
  });

  it('a fired plan lands on the approval screen with REJECT preselected; nothing is approved by itself', async () => {
    const api = makeApi(1, withOrder);
    await boot(api);
    await c!.pollPlans(true);
    await settle();
    expect(c!.getState()).toMatchObject({ currentScreen: 'proposal', voiceState: 'AWAITING_APPROVAL', approvalChoice: 'REJECT', armedPlans: 0 });
    expect(adapter.lastView?.header).toContain('PLAN FIRED');
    expect(adapter.lastView?.body.join('\n')).toContain('PLAN: BTC below 58,800.00 reached');
    expect(api.approve).not.toHaveBeenCalled();
    await gesture('click'); // an accidental tap rejects
    expect(api.reject).toHaveBeenCalledOnce();
    expect(api.execute).not.toHaveBeenCalled();
  });

  it('swipe then tap approves the fired plan order', async () => {
    const api = makeApi(1, withOrder);
    await boot(api);
    await c!.pollPlans(true);
    await settle();
    await gesture('swipe_down');
    await gesture('click');
    expect(api.approve).toHaveBeenCalledOnce();
    expect(api.execute).toHaveBeenCalledOnce();
    expect(c!.getState().currentScreen).toBe('result');
  });

  it('an alert without an order is a simple news screen', async () => {
    const api = makeApi(1, newsOnly);
    await boot(api);
    await c!.pollPlans(true);
    await settle();
    expect(c!.getState().currentScreen).toBe('alert');
    expect(adapter.lastView?.body.join('\n')).toContain('BTC BELOW 58,800.00');
    await gesture('click');
    expect(c!.getState().currentScreen).toBe('home');
  });

  it('never interrupts the wearer while listening', async () => {
    const api = makeApi(1, withOrder);
    await boot(api);
    await gesture('double_click'); // listening
    await c!.pollPlans(true);
    await settle();
    expect(api.checkPlans).not.toHaveBeenCalled();
    expect(c!.getState().voiceState).toBe('LISTENING');
    await gesture('long_press'); // cancel
    clock += 10_000;
    await c!.pollPlans();
    await settle();
    expect(c!.getState().currentScreen).toBe('proposal');
  });

  it('respects the poll interval', async () => {
    const api = makeApi(1, null);
    await boot(api);
    clock += 10_000;
    await c!.pollPlans();
    await c!.pollPlans();
    clock += 2_000;
    await c!.pollPlans();
    expect(api.checkPlans).toHaveBeenCalledTimes(1);
  });

  it('plan screens fit the display', () => {
    for (const s of [state({ currentScreen: 'alert', activeAlert: newsOnly }), state({ currentScreen: 'proposal', activeProposal: withOrder.proposal, activeAlert: withOrder }), state({ currentScreen: 'home', portfolio, watchlist, armedPlans: 5 })]) {
      const v = renderScreen(s);
      expect(v.body.length).toBeLessThanOrEqual(6);
      for (const l of [v.header, ...v.body, v.footer]) expect(l.length).toBeLessThanOrEqual(56);
    }
  });
});
