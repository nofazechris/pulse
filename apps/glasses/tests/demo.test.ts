import { describe, expect, it, vi } from 'vitest';
import { parseIntent } from '../../api/src/modules/ai/intent-parser';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { farAbove, nearAbove, wavPcm } from '../src/demo/driver';
import { holdMs, runDemo, type DemoDriver } from '../src/demo/runner';
import { DEMO_STEPS, totalSpeechMs } from '../src/demo/script';
import durations from '../src/demo/durations.json';
import narration from '../src/demo/narration.json';

function fakeDriver(over: Partial<DemoDriver> = {}) {
  const calls: string[] = [];
  const driver: DemoDriver = {
    prepare: vi.fn(async () => void calls.push('prepare')),
    say: vi.fn(async (t) => void calls.push(`say:${t}`)),
    voice: vi.fn(async (c) => void calls.push(`voice:${c}`)),
    gesture: vi.fn(async (g) => void calls.push(`gesture:${g}`)),
    waitAlert: vi.fn(async () => void calls.push('waitAlert')),
    restart: vi.fn(async () => void calls.push('restart')),
    ...over,
  };
  return { driver, calls };
}
const noSleep = async () => {};
const textOf = (id: string) => (DEMO_STEPS.find((s) => s.id === id)!.action as { text: string }).text.replace('{BTC_NEAR}', '58500').replace('{BTC_HIGH}', '70500');

describe('demo script and voiceover', () => {
  it('every narration line has a measured voice clip, and every step uses one', () => {
    for (const id of Object.keys(narration)) expect((durations as Record<string, number>)[id], id).toBeGreaterThan(500);
    expect(DEMO_STEPS.map((s) => s.id).sort()).toEqual(Object.keys(narration).filter((k) => !['title', 'how', 'who', 'closing'].includes(k)).sort());
  });

  it('fits a 3-minute video including the title card, closing card and network time', () => {
    const cards = durations.title + durations.how + durations.who + durations.closing + 3000;
    const networkAllowance = 40_000; // actions that outlast their narration (31 to 39 s in recorded takes)
    expect(cards + totalSpeechMs() + networkAllowance).toBeLessThanOrEqual(180_000);
  });

  it('every spoken line is understood by the deterministic parser as the intended action (no model needed)', () => {
    const expected: Record<string, string> = {
      start: 'START_SESSION', holding: 'GET_PORTFOLIO', why: 'ASK_FINANCIAL_QUESTION',
      plan: 'CREATE_PLAN', session: 'GET_SESSION_PNL', sell: 'PREPARE_TRADE', cancel: 'CANCEL_ORDER', remember: 'SAVE_MEMORY',
    };
    for (const step of DEMO_STEPS) {
      if (step.action.type !== 'say') continue;
      expect(parseIntent(textOf(step.id)).intent, step.id).toBe(expected[step.id]);
    }
  });

  it('the plan offers a 20 USDT buy, and the sell line is half the balance at a price that rests', () => {
    expect(parseIntent(textOf('plan')).params).toMatchObject({ asset: 'BTC', side: 'BUY', quote: '20', plan: { direction: 'BELOW', price: '58500' } });
    expect(parseIntent(textOf('sell')).params).toMatchObject({ asset: 'BTC', side: 'SELL', fraction: '0.5', orderType: 'LIMIT', price: '70500' });
    expect(Number(farAbove('60878.62'))).toBe(70500);
    expect(parseIntent('How is Bitcoin doing?').intent).toBe('GET_MARKET_CHANGE'); // the spoken clip
  });

  it('every order action is confirmed by hand, in order: the buy, the resting sell, then its cancel', () => {
    const ids = DEMO_STEPS.map((s) => s.id);
    const order = ['plan', 'fired', 'choose', 'approve', 'sell', 'place', 'cancel', 'confirm'];
    expect(order.map((id) => ids.indexOf(id))).toEqual([...order.map((id) => ids.indexOf(id))].sort((a, b) => a - b));
    const gestures = DEMO_STEPS.filter((s) => s.action.type === 'gesture').map((s) => [s.id, (s.action as { gesture: string }).gesture]);
    expect(gestures).toEqual([['choose', 'swipe_down'], ['approve', 'click']]);
    expect(DEMO_STEPS.filter((s) => s.action.type === 'confirm').map((s) => s.id)).toEqual(['place', 'confirm']);
  });

  it('reads the PCM out of the recorded wearer clip (16 kHz mono, as the G2 microphone delivers)', () => {
    const file = readFileSync(fileURLToPath(new URL('../public/demo/wearer-btc.wav', import.meta.url)));
    const pcm = wavPcm(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
    expect(file.readUInt32LE(24)).toBe(16000);
    expect(file.readUInt16LE(22)).toBe(1);
    expect(pcm.length).toBeGreaterThan(16000); // more than half a second of speech
    expect(() => wavPcm(new ArrayBuffer(10))).toThrow(/not a WAV/);
  });

  it('sets the plan level just above the live price so it fires on camera', () => {
    expect(nearAbove('58211.92')).toBe('58450');
    for (const p of ['58000', '60005.95', '99999']) {
      expect(Number(nearAbove(p))).toBeGreaterThan(Number(p) * 1.003);
      expect(Number(nearAbove(p))).toBeLessThan(Number(p) * 1.006);
    }
  });
});

describe('demo runner', () => {
  it('prepares first, then performs every step in order', async () => {
    const { driver, calls } = fakeDriver();
    const r = await runDemo(driver, { sleep: noSleep });
    expect(calls[0]).toBe('prepare');
    expect(calls.slice(1)).toEqual([
      'say:Pulse, start my trading session', "say:What's my biggest holding?", 'voice:wearer-btc', 'say:Why is Bitcoin moving today?',
      'say:Alert me if Bitcoin is below {BTC_NEAR} and buy 20 dollars', 'waitAlert', 'gesture:swipe_down', 'gesture:click', 'say:How is my session?',
      'say:Sell half my Bitcoin at {BTC_HIGH}', 'gesture:swipe_down', 'gesture:click', 'say:Cancel my order', 'gesture:swipe_down', 'gesture:click',
      'say:Remember that I focus on BTC and ETH', 'restart',
    ]);
    expect(r).toEqual({ completed: DEMO_STEPS.length, errors: [], aborted: false });
  });

  it('holds each step until its narration is over, counting the time the action took', () => {
    expect(holdMs({ voiceMs: 6000 }, 0)).toBe(6500);
    expect(holdMs({ voiceMs: 6000 }, 4000)).toBe(2500);
    expect(holdMs({ voiceMs: 3000 }, 9000)).toBe(1500); // slow action: still a short beat to read
    expect(holdMs({ voiceMs: 6000 }, 0, 0.5)).toBe(3250);
  });

  it('passes the measured action time into the hold', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const say = vi.fn(async () => { t += 2000; });
    await runDemo(fakeDriver({ say }).driver, { sleep: async (ms) => void sleeps.push(ms), now: () => t });
    const i = DEMO_STEPS.findIndex((s) => s.id === 'start');
    expect(sleeps[i]).toBe(holdMs(DEMO_STEPS[i]!, 2000));
  });

  it('counts down before the first step', async () => {
    const seen: number[] = [];
    await runDemo(fakeDriver().driver, { sleep: noSleep, countdownSeconds: 3, onCountdown: (n) => void seen.push(n) });
    expect(seen).toEqual([3, 2, 1, 0]);
  });

  it('a failing step is reported and the run continues', async () => {
    const waitAlert = vi.fn(async () => { throw new Error('timed out'); });
    const r = await runDemo(fakeDriver({ waitAlert }).driver, { sleep: noSleep });
    expect(r.errors).toEqual([{ step: 'fired', message: 'timed out' }]);
    expect(r.completed).toBe(DEMO_STEPS.length);
  });

  it('can be stopped mid-run', async () => {
    const ctl = new AbortController();
    const say = vi.fn(async (t: string) => { if (t.includes('biggest')) ctl.abort(); });
    const { driver, calls } = fakeDriver({ say });
    const r = await runDemo(driver, { sleep: noSleep, signal: ctl.signal });
    expect(r.aborted).toBe(true);
    expect(calls).not.toContain('restart');
  });
});
