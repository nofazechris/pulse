import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentReply } from '@pulse/shared';
import { SimulatorAdapter } from '../src/sdk/SimulatorAdapter';
import { ApiRequestError, type ApiClient } from '../src/services/api';
import { createTokenStore } from '../src/services/tokenStore';
import { PulseController } from '../src/state/controller';
import { executeResult, portfolio, proposal, reply, stats, watchlist } from './fixtures';

const SESSION = '00000000-0000-4000-8000-000000000003';
const memStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

function makeApi(over: Record<string, unknown> = {}) {
  const api = {
    lastRequestId: null, lastError: null,
    newIdempotencyKey: () => 'pulse-test-key-0001',
    health: vi.fn(async () => ({ status: 'ok', database: 'connected', exchange: 'available', environment: 'testnet' })),
    pair: vi.fn(async () => ({ accessToken: 'tok', expiresAt: new Date(Date.now() + 3600_000).toISOString(), user: { id: 'u', displayName: 'x' } })),
    session: vi.fn(async () => ({ expiresAt: '', user: { id: 'u', displayName: null } })),
    startSession: vi.fn(async () => ({ session: { id: SESSION, startedAt: '', endedAt: null, summary: null, status: 'active' }, greeting: reply({ intent: 'START_SESSION', data: { mode: 'LIVE' } }) })),
    portfolio: vi.fn(async () => portfolio),
    watchlist: vi.fn(async () => watchlist),
    stats: vi.fn(async () => stats),
    message: vi.fn(async (): Promise<AgentReply> => reply()),
    transcribe: vi.fn(async () => ({ text: 'show my portfolio', provider: 'test' })),
    approve: vi.fn(async () => proposal({ status: 'APPROVED' })),
    reject: vi.fn(async () => proposal({ status: 'REJECTED' })),
    execute: vi.fn(async () => executeResult()),
    endSession: vi.fn(),
    memories: vi.fn(async () => []),
    ...over,
  };
  return api as unknown as ApiClient & typeof api;
}

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };
const pcm = (ms = 400) => new Uint8Array(32 * ms);

let adapter: SimulatorAdapter;
let c: PulseController | undefined;

async function boot(api = makeApi(), opts: { autoPair?: string } = { autoPair: 'code-1234' }) {
  adapter = new SimulatorAdapter();
  c = new PulseController({ adapter, api, tokens: createTokenStore(memStorage()), autoPairCode: opts.autoPair });
  await c.start();
  await settle();
  return { api, c };
}

/** Wait past the duplicate-gesture window so consecutive identical gestures are treated as separate presses. */
let clock = 1_000_000;
const gesture = async (g: Parameters<SimulatorAdapter['emitGesture']>[0]) => {
  clock += 1000;
  vi.setSystemTime(clock);
  adapter.emitGesture(g);
  await settle();
};

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(clock); });
afterEach(async () => { await c?.dispose(); c = undefined; vi.useRealTimers(); });

describe('startup and connection states', () => {
  it('connects, pairs (dev auto-pair), starts a session and shows home with real data', async () => {
    const { api, c } = await boot();
    expect(api.pair).toHaveBeenCalledOnce();
    expect(c.getState()).toMatchObject({ currentScreen: 'home', connectionStatus: 'connected', authenticationStatus: 'authenticated', activeSessionId: SESSION });
    expect(adapter.lastView?.body.join('\n')).toContain('123,456.78 USDT');
  });
  it('shows an offline state (and no values) when the backend is unreachable', async () => {
    const { c } = await boot(makeApi({ health: vi.fn(async () => { throw new ApiRequestError(0, 'NETWORK', 'x'); }) }));
    expect(c.getState()).toMatchObject({ connectionStatus: 'offline', currentScreen: 'connection', backend: 'down' });
    expect(adapter.lastView?.header).toContain('PULSE');
    expect(adapter.lastView?.body.join('\n')).toContain('OFFLINE');
  });
  it('requires pairing when there is no token and no dev auto-pair', async () => {
    const api = makeApi();
    const { c } = await boot(api, {});
    expect(api.pair).not.toHaveBeenCalled();
    expect(c.getState()).toMatchObject({ connectionStatus: 'auth_required', currentScreen: 'connection' });
    expect(adapter.lastView?.body.join('\n')).toContain('pairing code');
  });
  it('a 401 mid-session returns to the pairing state instead of acting on stale auth', async () => {
    const api = makeApi({ message: vi.fn(async () => { throw new ApiRequestError(401, 'UNAUTHENTICATED', 'Sign in again'); }) });
    const { c } = await boot(api);
    await c.submitText('show my portfolio');
    await settle();
    expect(c.getState()).toMatchObject({ connectionStatus: 'auth_required', authenticationStatus: 'unauthenticated' });
  });
  it('shows the exchange-unavailable state from health', async () => {
    const down = vi.fn(async () => { throw new ApiRequestError(503, 'EXCHANGE_UNAVAILABLE', 'Binance Testnet is unavailable right now.'); });
    const { c } = await boot(makeApi({ health: vi.fn(async () => ({ status: 'degraded', database: 'connected', exchange: 'unavailable', environment: 'testnet' })), portfolio: down, watchlist: down }));
    expect(c.getState().exchange).toBe('down');
    expect(c.getState().portfolio).toBeNull(); // no invented values
  });
});

describe('touch navigation', () => {
  it('swipe cycles main screens from home; lists scroll; click drills in; long press goes home', async () => {
    await boot();
    await gesture('swipe_down');
    expect(c!.getState().currentScreen).toBe('portfolio');
    await gesture('click'); // portfolio -> market (first watchlist asset)
    expect(c!.getState()).toMatchObject({ currentScreen: 'market', marketSymbol: 'BTCUSDT' });
    await gesture('swipe_down'); // next asset
    expect(c!.getState().marketSymbol).toBe('ETHUSDT');
    await gesture('long_press');
    expect(c!.getState().currentScreen).toBe('home');
    await gesture('swipe_up'); // home -> previous in the cycle = watchlist
    expect(c!.getState().currentScreen).toBe('watchlist');
    await gesture('swipe_down'); // moves the selection inside the watchlist
    expect(c!.getState().listIndex).toBe(1);
    await gesture('click'); // opens the selected asset
    expect(c!.getState()).toMatchObject({ currentScreen: 'market', marketSymbol: 'ETHUSDT' });
    await gesture('long_press');
    expect(c!.getState().currentScreen).toBe('home');
  });
  it('ignores a duplicate of the same physical gesture within the dedupe window', async () => {
    await boot();
    clock += 1000; vi.setSystemTime(clock);
    adapter.emitGesture('swipe_down');
    adapter.emitGesture('swipe_down');
    await settle();
    expect(c!.getState().currentScreen).toBe('portfolio'); // one step, not two
  });
});

describe('voice state machine', () => {
  it('double-tap starts listening, a second double-tap with no audio reports an error and recovers', async () => {
    vi.useRealTimers();
    await boot();
    adapter.emitGesture('double_click');
    await settle();
    expect(c!.getState().voiceState).toBe('LISTENING');
    expect(adapter.listening).toBe(true);
    expect(adapter.lastView?.header).toBe('LISTENING');
    await new Promise((r) => setTimeout(r, GESTURE_GAP));
    adapter.emitGesture('double_click');
    await settle();
    expect(c!.getState().voiceState).toBe('ERROR');
    expect(c!.getState().lastError).toMatch(/No audio captured/);
    expect(adapter.listening).toBe(false);
  });

  it('captured audio is transcribed, then sent as a voice message (single request)', async () => {
    vi.useRealTimers();
    const { api } = await boot();
    adapter.emitGesture('double_click');
    await settle();
    adapter.emitAudio(pcm());
    await new Promise((r) => setTimeout(r, GESTURE_GAP));
    adapter.emitGesture('double_click');
    await settle();
    expect(api.transcribe).toHaveBeenCalledOnce();
    expect(api.message).toHaveBeenCalledOnce();
    expect(api.message.mock.calls[0]![0]).toMatchObject({ text: 'show my portfolio', source: 'voice', sessionId: SESSION });
    expect(c!.getState().voiceState).toBe('IDLE');
  });

  it('long press cancels listening without sending anything', async () => {
    vi.useRealTimers();
    const { api } = await boot();
    adapter.emitGesture('double_click');
    await settle();
    adapter.emitAudio(pcm());
    await new Promise((r) => setTimeout(r, GESTURE_GAP));
    adapter.emitGesture('long_press');
    await settle();
    expect(c!.getState().voiceState).toBe('IDLE');
    expect(api.transcribe).not.toHaveBeenCalled();
    expect(api.message).not.toHaveBeenCalled();
  });

  it('ignores repeated submissions while a request is processing (no duplicate requests)', async () => {
    vi.useRealTimers();
    let release!: (r: AgentReply) => void;
    const api = makeApi({ message: vi.fn(() => new Promise<AgentReply>((r) => { release = r; })) });
    await boot(api);
    const first = c!.submitText('show my portfolio');
    await settle();
    expect(c!.getState().voiceState).toBe('PROCESSING');
    await c!.submitText('show my portfolio');
    await c!.submitText('show my portfolio');
    expect(api.message).toHaveBeenCalledTimes(1);
    release(reply());
    await first;
    await settle();
    expect(c!.getState().voiceState).toBe('IDLE');
  });

  it('reports STT being unavailable instead of failing silently', async () => {
    vi.useRealTimers();
    const api = makeApi({ transcribe: vi.fn(async () => { throw new ApiRequestError(501, 'STT_UNAVAILABLE', 'Speech recognition is not configured. Type your request instead.'); }) });
    await boot(api);
    adapter.emitGesture('double_click');
    await settle();
    adapter.emitAudio(pcm());
    await new Promise((r) => setTimeout(r, GESTURE_GAP));
    adapter.emitGesture('double_click');
    await settle();
    expect(c!.getState().voiceState).toBe('ERROR');
    expect(c!.getState().lastError).toMatch(/not configured/);
  });

  it('shows answers on the insight screen with labelled sections', async () => {
    await boot(makeApi({ message: vi.fn(async () => reply({ sections: [{ label: 'FACT', text: 'BTCUSDT 59,980.00' }, { label: 'UNVERIFIED', text: 'Cause cannot be verified.' }] })) }));
    await c!.submitText('why is bitcoin moving');
    await settle();
    expect(c!.getState().currentScreen).toBe('insight');
    expect(adapter.lastView?.body.join('\n')).toMatch(/FACT: .*\n?.*UNVERIFIED/s);
  });
});

const GESTURE_GAP = 220; // > GESTURE_DEDUPE_MS, in real time

async function showProposal(api = makeApi()) {
  const p = proposal();
  api.message.mockResolvedValueOnce(reply({ intent: 'PREPARE_TRADE', response: 'Review', uiAction: { type: 'SHOW_PROPOSAL', proposal: p } }));
  const ctl = (await boot(api)).c;
  await ctl.submitText('buy 20 usdt of btc');
  await settle();
  return { api, p, ctl };
}

describe('trade approval safety on the glasses', () => {
  it('a proposal opens on the approval screen, awaiting approval, defaulting to REJECT; nothing is sent yet', async () => {
    const { api, ctl } = await showProposal();
    expect(ctl.getState()).toMatchObject({ currentScreen: 'proposal', voiceState: 'AWAITING_APPROVAL', approvalChoice: 'REJECT' });
    expect(api.approve).not.toHaveBeenCalled();
    expect(api.execute).not.toHaveBeenCalled();
  });

  it('a plain tap with the default selection REJECTS (never approves)', async () => {
    const { api } = await showProposal();
    await gesture('click');
    expect(api.reject).toHaveBeenCalledOnce();
    expect(api.approve).not.toHaveBeenCalled();
    expect(api.execute).not.toHaveBeenCalled();
    expect(c!.getState().currentScreen).toBe('home');
  });

  it('double-tap and long-press on the proposal are cancel, even with APPROVE selected', async () => {
    const { api } = await showProposal();
    await gesture('swipe_down');
    expect(c!.getState().approvalChoice).toBe('APPROVE');
    await gesture('double_click');
    expect(api.approve).not.toHaveBeenCalled();
    expect(api.reject).toHaveBeenCalledOnce();
  });

  it('swipe to APPROVE then tap approves the exact displayed hash, then executes with an idempotency key', async () => {
    const { api, p } = await showProposal();
    await gesture('swipe_down');
    await gesture('click');
    expect(api.approve).toHaveBeenCalledWith(p.id, { sessionId: p.sessionId, proposalHash: p.proposalHash, method: 'glasses_gesture' });
    expect(api.execute).toHaveBeenCalledWith(p.id, 'pulse-test-key-0001');
    expect(api.approve.mock.invocationCallOrder[0]!).toBeLessThan(api.execute.mock.invocationCallOrder[0]!);
    expect(c!.getState().currentScreen).toBe('result');
    expect(adapter.lastView?.header).toContain('CONFIRMED');
  });

  it('a second tap during execution cannot double-submit', async () => {
    let release!: () => void;
    const api = makeApi({ execute: vi.fn(() => new Promise((r) => { release = () => r(executeResult()); })) });
    await showProposal(api);
    await gesture('swipe_down');
    await gesture('click');
    await gesture('click');
    await gesture('click');
    expect(api.approve).toHaveBeenCalledTimes(1);
    expect(api.execute).toHaveBeenCalledTimes(1);
    release();
    await settle();
  });

  it('shows the real exchange state when the order is unverified (never success)', async () => {
    const api = makeApi({ execute: vi.fn(async () => executeResult({ order: null, message: 'Order status is being verified.', proposal: proposal({ status: 'UNKNOWN' }) })) });
    await showProposal(api);
    await gesture('swipe_down');
    await gesture('click');
    const text = adapter.lastView!.body.join(' ') + adapter.lastView!.header;
    expect(text).toContain('PENDING');
    expect(text).not.toMatch(/success|bought/i);
  });

  it('voice approve only works for the proposal that is on screen, and approves the DISPLAYED hash', async () => {
    const p = proposal();
    const api = makeApi();
    api.message
      .mockResolvedValueOnce(reply({ intent: 'PREPARE_TRADE', uiAction: { type: 'SHOW_PROPOSAL', proposal: p } }))
      // A server (or model) claims a different proposal id/hash: the client must not act on it.
      .mockResolvedValueOnce(reply({ intent: 'APPROVE_TRADE', uiAction: { type: 'APPROVE_PROPOSAL', proposalId: '00000000-0000-4000-8000-0000000000ff', proposalHash: 'b'.repeat(64) } }))
      .mockResolvedValueOnce(reply({ intent: 'APPROVE_TRADE', uiAction: { type: 'APPROVE_PROPOSAL', proposalId: p.id, proposalHash: 'c'.repeat(64) } }));
    await boot(api);
    await c!.submitText('buy 20 usdt of btc');
    await settle();
    await c!.submitText('approve');
    await settle();
    expect(api.approve).not.toHaveBeenCalled();
    await c!.submitText('approve');
    await settle();
    expect(api.approve).toHaveBeenCalledOnce();
    expect(api.approve.mock.calls[0]![1]).toMatchObject({ proposalHash: p.proposalHash, method: 'voice' }); // not the 'c' hash from the reply
  });

  it('a voice approve with no proposal on screen does nothing', async () => {
    const api = makeApi();
    api.message.mockResolvedValueOnce(reply({ intent: 'APPROVE_TRADE', uiAction: { type: 'APPROVE_PROPOSAL', proposalId: proposal().id, proposalHash: 'a'.repeat(64) } }));
    await boot(api);
    await c!.submitText('approve');
    await settle();
    expect(api.approve).not.toHaveBeenCalled();
    expect(api.execute).not.toHaveBeenCalled();
  });

  it('when the price moved, shows the NEW proposal for fresh approval (defaulting to REJECT)', async () => {
    const fresh = proposal({ id: '00000000-0000-4000-8000-0000000000aa', proposalHash: 'd'.repeat(64), referencePrice: '63000' });
    const api = makeApi({ execute: vi.fn(async () => { throw new ApiRequestError(409, 'REQUOTE_REQUIRED', 'The price moved.', { proposal: fresh }); }) });
    await showProposal(api);
    await gesture('swipe_down');
    await gesture('click');
    expect(c!.getState()).toMatchObject({ currentScreen: 'proposal', approvalChoice: 'REJECT' });
    expect(c!.getState().activeProposal?.id).toBe(fresh.id);
    expect(adapter.lastView?.footer).toBeTruthy();
    expect(api.execute).toHaveBeenCalledTimes(1);
  });

  it('an expired proposal is dismissed with a notice and nothing is sent', async () => {
    const p = proposal({ expiresAt: new Date(clock + 1500).toISOString() });
    const api = makeApi();
    api.message.mockResolvedValueOnce(reply({ intent: 'PREPARE_TRADE', uiAction: { type: 'SHOW_PROPOSAL', proposal: p } }));
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(clock);
    await boot(api);
    await c!.submitText('buy 20 usdt of btc');
    await settle();
    vi.setSystemTime(clock + 5000);
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(c!.getState().currentScreen).toBe('home');
    expect(c!.getState().notice).toMatch(/expired/i);
    expect(api.approve).not.toHaveBeenCalled();
  });
});

describe('failure recovery', () => {
  it('after an approved order fails before confirmation, a tap retries the SAME order (no second approval, same idempotency key)', async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new ApiRequestError(0, 'NETWORK', 'Cannot reach the PULSE backend.'))
      .mockResolvedValueOnce(executeResult());
    const api = makeApi({ execute });
    await showProposal(api);
    await gesture('swipe_down');
    await gesture('click'); // approve + execute (fails)
    expect(c!.getState()).toMatchObject({ currentScreen: 'error', retryOrder: true });
    expect(adapter.lastView?.footer).toContain('RETRY SAME ORDER');
    await gesture('click'); // retry
    expect(api.approve).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]![1]).toBe(execute.mock.calls[1]![1]); // same idempotency key
    expect(c!.getState().currentScreen).toBe('result');
  });
  it('leaving the error screen cancels the retry', async () => {
    const api = makeApi({ execute: vi.fn().mockRejectedValue(new ApiRequestError(503, 'EXCHANGE_UNAVAILABLE', 'Binance Testnet is unavailable right now.')) });
    await showProposal(api);
    await gesture('swipe_down');
    await gesture('click');
    await gesture('long_press'); // home
    expect(c!.getState().retryOrder).toBe(false);
    await gesture('click'); // on home this opens the portfolio, never retries the order
    expect(api.execute).toHaveBeenCalledTimes(1);
  });
  it('a definitive refusal (e.g. expired) is not retryable', async () => {
    const api = makeApi({ execute: vi.fn().mockRejectedValue(new ApiRequestError(409, 'PROPOSAL_EXPIRED', 'This proposal expired.')) });
    await showProposal(api);
    await gesture('swipe_down');
    await gesture('click');
    expect(c!.getState().retryOrder).toBe(false);
  });
  it('dev auto-pair starts exactly one session', async () => {
    const { api } = await boot();
    expect(api.startSession).toHaveBeenCalledTimes(1);
  });
});
describe('stale responses', () => {
  it('a slow older market request cannot overwrite a newer one', async () => {
    const pending: Array<{ symbol: string; resolve: (v: typeof stats) => void }> = [];
    const api = makeApi({ stats: vi.fn((symbol: string) => new Promise<typeof stats>((resolve) => pending.push({ symbol, resolve }))) });
    await boot(api);
    await gesture('swipe_down'); // home -> portfolio
    await gesture('click'); // -> market, request 1 (BTCUSDT) stays pending
    await gesture('swipe_down'); // next asset, request 2 (ETHUSDT)
    expect(pending.map((p) => p.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    pending[1]!.resolve({ ...stats, symbol: 'ETHUSDT', lastPrice: '2990.00' }); // newer answers first
    await settle();
    pending[0]!.resolve({ ...stats, symbol: 'BTCUSDT', lastPrice: '1.00' }); // stale answer arrives late
    await settle();
    expect(c!.getState().market?.symbol).toBe('ETHUSDT');
    expect(c!.getState().marketSymbol).toBe('ETHUSDT');
  });
});
