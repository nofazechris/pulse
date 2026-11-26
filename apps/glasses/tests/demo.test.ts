import { describe, expect, it, vi } from 'vitest';
import { parseIntent } from '../../api/src/modules/ai/intent-parser';
import { runDemo, type DemoDriver } from '../src/demo/runner';
import { DEMO_STEPS, totalDwellMs } from '../src/demo/script';

function fakeDriver(over: Partial<DemoDriver> = {}) {
  const calls: string[] = [];
  const driver: DemoDriver = {
    prepare: vi.fn(async () => void calls.push('prepare')),
    say: vi.fn(async (t) => void calls.push(`say:${t}`)),
    gesture: vi.fn(async (g) => void calls.push(`gesture:${g}`)),
    endSession: vi.fn(async () => void calls.push('end')),
    newSession: vi.fn(async () => void calls.push('new')),
    ...over,
  };
  return { driver, calls };
}
const noSleep = async () => {};

describe('demo script', () => {
  it('fits a 3-minute video: dwell time leaves room for network latency', () => {
    // ~15 backend round trips at ~4 s each (Nigeria -> Neon/Binance) is the other half of the budget.
    expect(totalDwellMs()).toBeLessThanOrEqual(100_000);
    expect(totalDwellMs(DEMO_STEPS, 0.7)).toBeLessThan(totalDwellMs());
  });

  it('every spoken line is understood by the deterministic parser as the intended action (no model needed)', () => {
    const expected: Record<string, string> = {
      start: 'START_SESSION', holding: 'GET_PORTFOLIO', perf: 'GET_MARKET_CHANGE', why: 'ASK_FINANCIAL_QUESTION',
      watch: 'ADD_WATCHLIST_ASSET', prepare: 'PREPARE_TRADE', status: 'GET_ORDER_STATUS', remember: 'SAVE_MEMORY',
    };
    for (const step of DEMO_STEPS) {
      if (step.action.type !== 'say') continue;
      expect(parseIntent(step.action.text).intent, step.id).toBe(expected[step.id]);
    }
  });

  it('the trade step is a $50 BTC buy and the approval is an explicit swipe then tap, in that order', () => {
    const ids = DEMO_STEPS.map((s) => s.id);
    expect(parseIntent((DEMO_STEPS.find((s) => s.id === 'prepare')!.action as { text: string }).text).params).toMatchObject({ asset: 'BTC', side: 'BUY', quote: '50' });
    const choose = ids.indexOf('choose');
    const approve = ids.indexOf('approve');
    expect(ids.indexOf('prepare')).toBeLessThan(choose);
    expect(choose).toBeLessThan(approve);
    expect(DEMO_STEPS[choose]!.action).toEqual({ type: 'gesture', gesture: 'swipe_down' });
    expect(DEMO_STEPS[approve]!.action).toEqual({ type: 'gesture', gesture: 'click' });
    // exactly one order in the whole demo
    expect(DEMO_STEPS.filter((s) => s.action.type === 'say' && /buy|sell/i.test(s.action.text))).toHaveLength(1);
  });

  it('has a unique id, a title and teleprompter narration for every step', () => {
    expect(new Set(DEMO_STEPS.map((s) => s.id)).size).toBe(DEMO_STEPS.length);
    for (const s of DEMO_STEPS) {
      expect(s.title.length).toBeGreaterThan(2);
      expect(s.narration.length).toBeGreaterThan(10);
      expect(s.dwellMs).toBeGreaterThan(0);
    }
  });
});

describe('demo runner', () => {
  it('prepares first, then performs every step in order', async () => {
    const { driver, calls } = fakeDriver();
    const r = await runDemo(driver, { sleep: noSleep });
    expect(calls[0]).toBe('prepare');
    expect(calls.slice(1)).toEqual([
      'say:Pulse, start my trading session', "say:What's my biggest holding?", 'say:How is Bitcoin performing?', 'say:Why is Bitcoin moving today?',
      'gesture:swipe_down', 'say:Add SOL to my watchlist', 'say:Prepare a $50 BTC buy', 'gesture:swipe_down', 'gesture:click',
      'say:What happened to my last order?', 'say:Remember that I focus on BTC and ETH', 'end', 'new',
    ]);
    expect(r).toEqual({ completed: DEMO_STEPS.length, errors: [], aborted: false });
  });

  it('holds each result on screen for its dwell time, scaled by pace', async () => {
    const sleeps: number[] = [];
    await runDemo(fakeDriver().driver, { sleep: async (ms) => void sleeps.push(ms), pace: 0.5 });
    expect(sleeps).toEqual(DEMO_STEPS.map((s) => s.dwellMs * 0.5));
  });

  it('counts down before the first step so recording can start', async () => {
    const seen: number[] = [];
    const order: string[] = [];
    const { driver } = fakeDriver({ say: vi.fn(async () => void order.push('say')) });
    await runDemo(driver, { sleep: noSleep, countdownSeconds: 3, onCountdown: (n) => void (seen.push(n), order.push(`c${n}`)) });
    expect(seen).toEqual([3, 2, 1, 0]);
    expect(order.indexOf('c1')).toBeLessThan(order.indexOf('say'));
  });

  it('a failing step is reported and the run continues (one slow call never ruins a take)', async () => {
    const say = vi.fn(async (t: string) => { if (t.includes('Bitcoin performing')) throw new Error('boom'); });
    const events: string[] = [];
    const r = await runDemo(fakeDriver({ say }).driver, { sleep: noSleep, onStep: (_i, s, st) => void events.push(`${s.id}:${st}`) });
    expect(r.errors).toEqual([{ step: 'perf', message: 'boom' }]);
    expect(r.completed).toBe(DEMO_STEPS.length);
    expect(events).toContain('perf:error');
    expect(events).toContain('outro:done');
  });

  it('can be stopped mid-run without finishing the remaining steps', async () => {
    const ctl = new AbortController();
    const say = vi.fn(async (t: string) => { if (t.includes('biggest holding')) ctl.abort(); });
    const { driver, calls } = fakeDriver({ say });
    const r = await runDemo(driver, { sleep: noSleep, signal: ctl.signal });
    expect(r.aborted).toBe(true);
    expect(calls).not.toContain('end');
    expect(r.completed).toBeLessThan(DEMO_STEPS.length);
  });

  it('reports step status transitions running -> dwelling -> done', async () => {
    const statuses: string[] = [];
    await runDemo(fakeDriver().driver, { sleep: noSleep, onStep: (i, _s, st) => { if (i === 1) statuses.push(st); } });
    expect(statuses).toEqual(['running', 'dwelling', 'done']);
  });
});
