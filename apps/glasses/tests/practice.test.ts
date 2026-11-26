import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseIntent } from '@pulse/shared';
import { PracticeApi } from '../src/practice/api';
import { PRACTICE_REQUESTS } from '../src/practice/requests';
import { SimulatorAdapter } from '../src/sdk/SimulatorAdapter';
import { ApiRequestError, type PulseApi } from '../src/services/api';
import { createTokenStore } from '../src/services/tokenStore';
import { PulseController } from '../src/state/controller';
import { BODY_LINES } from '../src/utils/text';

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };
let c: PulseController | undefined;
afterEach(async () => { await c?.dispose(); c = undefined; vi.unstubAllGlobals(); });

/** A controller whose real backend is unreachable, as on a machine with no PULSE server. */
async function boot() {
  let clock = 1_000_000;
  const network = vi.fn(async () => { throw new Error('no network allowed'); });
  vi.stubGlobal('fetch', network);
  const down = { health: vi.fn(async () => { throw new ApiRequestError(0, 'NETWORK', 'Cannot reach the PULSE backend.'); }) } as unknown as PulseApi;
  const adapter = new SimulatorAdapter();
  const seen: string[] = [];
  const render = adapter.render.bind(adapter);
  adapter.render = async (v) => { seen.push([v.header, ...v.body, v.footer].join('\n')); expect(v.body.length).toBeLessThanOrEqual(BODY_LINES); await render(v); };
  c = new PulseController({
    adapter, api: down, tokens: createTokenStore(null), clock: () => clock,
    practice: () => ({ api: new PracticeApi(() => clock), tokens: createTokenStore(null) }),
  });
  await c.start();
  await settle();
  const gesture = async (g: Parameters<SimulatorAdapter['emitGesture']>[0]) => { clock += 500; adapter.emitGesture(g); await settle(); };
  /** From any calm screen: double-tap, swipe to the request, tap. */
  const run = async (request: string) => {
    await gesture('double_click');
    expect(c!.getState().currentScreen).toBe('try');
    for (let i = 0; i < PRACTICE_REQUESTS.indexOf(request); i++) await gesture('swipe_down');
    await gesture('click');
  };
  const screen = () => [adapter.lastView!.header, ...adapter.lastView!.body].join('\n');
  return { adapter, gesture, run, screen, seen, network, down, advance: (ms: number) => { clock += ms; } };
}

describe('practice mode: the whole app with no server, using only taps and swipes', () => {
  it('is offered when the server is unreachable, and entered only by choice', async () => {
    const h = await boot();
    expect(c!.getState()).toMatchObject({ currentScreen: 'connection', practice: false });
    expect(h.screen()).toContain('DBL-TAP: PRACTICE, NO SERVER');
    await h.gesture('double_click');
    expect(c!.getState()).toMatchObject({ currentScreen: 'home', practice: true, mode: 'DEMO' });
    expect(h.screen()).toContain('PULSE  DEMO');
  });

  it('buys, rests a sell, cancels it and shows P&L, without any network call or exchange claim', async () => {
    const h = await boot();
    await h.gesture('double_click');
    const practiceFrom = h.seen.length - 1;

    await h.run('Buy 20 dollars of Bitcoin');
    expect(h.screen()).toContain('TRADE PROPOSAL  DEMO');
    expect(h.screen()).toContain('> REJECT <');
    await h.gesture('swipe_down');
    await h.gesture('click');
    expect(h.screen()).toContain('ORDER RESULT  SIMULATED');
    expect(h.screen()).toMatch(/BOUGHT 0\.00033 BTC\n/);
    expect(h.screen()).toContain('DEMO ORDER #D1001');

    await h.run('Sell half my Bitcoin at 69000');
    expect(h.screen()).toContain('LIMIT 69,000.00');
    await h.gesture('swipe_down');
    await h.gesture('click');
    expect(h.screen()).toContain('WAITING TO FILL');

    await h.run('Cancel my order');
    expect(h.screen()).toContain('> KEEP <');
    await h.gesture('swipe_down');
    await h.gesture('click');
    expect(h.screen()).toContain('ORDER CANCELLED  SIMULATED');

    await h.gesture('click'); // home
    await h.run('How is my session?');
    expect(h.screen()).toContain('Session P&L:');
    await h.run('Why is Bitcoin moving today?');
    expect(h.screen()).toContain('UNVERIFIED');

    const everything = h.seen.slice(practiceFrom).join('\n');
    expect(everything).not.toMatch(/BINANCE|TESTNET|CONFIRMED|VERIFIED DATA/);
    expect(h.network).not.toHaveBeenCalled();
  }, 30_000);

  it('a plan fires on the moving sample price and still needs approval', async () => {
    const h = await boot();
    await h.gesture('double_click');
    await h.run('If Bitcoin drops 2 percent, buy 20 dollars');
    expect(h.screen()).toContain('Plan armed: BTC below');
    await c!.pollPlans(true);
    expect(c!.getState().currentScreen).toBe('insight');
    h.advance(90_000); // three quarters of the sample price cycle: 2.5% below where it started
    await c!.pollPlans(true);
    await settle();
    expect(h.screen()).toContain('PLAN FIRED  DEMO');
    expect(c!.getState()).toMatchObject({ currentScreen: 'proposal', approvalChoice: 'REJECT' });
  });

  it('understands every request it offers', () => {
    for (const text of PRACTICE_REQUESTS) expect(parseIntent(text).intent, text).not.toBe('UNKNOWN');
  });

  it('keeps the approval rules: no execution without approval, never twice', async () => {
    const api = new PracticeApi(() => 0);
    const { session } = await api.startSession();
    const r = await api.message({ sessionId: session.id, text: 'buy 20 dollars of bitcoin' });
    const p = (r.uiAction as { proposal: { id: string; proposalHash: string } }).proposal;
    await expect(api.execute(p.id)).rejects.toThrow(/not been approved/);
    await expect(api.approve(p.id, { sessionId: session.id, proposalHash: 'something-else' })).rejects.toThrow(/changed/);
    await api.approve(p.id, { sessionId: session.id, proposalHash: p.proposalHash });
    const first = await api.execute(p.id);
    const usdt = async () => (await api.portfolio()).balances.find((b) => b.asset === 'USDT')!.total;
    const after = await usdt();
    expect(await api.execute(p.id)).toEqual(first);
    expect(await usdt()).toBe(after);
    await expect(api.transcribe()).rejects.toThrow(/needs the PULSE server/);
  });
});
