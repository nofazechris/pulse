import { describe, expect, it } from 'vitest';
import { renderScreen } from '../src/screens';
import { BODY_LINES } from '../src/utils/text';
import { ascii, clip, wrap } from '../src/utils/text';
import { executeResult, portfolio, proposal, reply, state, stats, watchlist } from './fixtures';
import type { PulseState } from '../src/state/types';

const longReply = reply({
  intent: 'ASK_FINANCIAL_QUESTION',
  sections: [
    { label: 'FACT', text: 'BTCUSDT last price 59,980.00 (testnet, 3s old). 24h change +2.40%, high 61,000.00, low 58,500.00.' },
    { label: 'AI', text: 'Volume looks elevated compared with the 24h range, which may reflect more market interest.' },
    { label: 'UNVERIFIED', text: 'I cannot verify why it moved: no news or event data source is connected.' },
  ],
});

const screens: Array<[string, PulseState]> = [
  ['connection', state({ currentScreen: 'connection', backend: 'ok', exchange: 'ok', authenticationStatus: 'authenticated' })],
  ['connection (pairing)', state({ currentScreen: 'connection', connectionStatus: 'auth_required', backend: 'ok', exchange: 'ok' })],
  ['connection (offline)', state({ currentScreen: 'connection', connectionStatus: 'offline', backend: 'down', lastError: 'Cannot reach the PULSE backend.' })],
  ['home', state({ currentScreen: 'home', portfolio, watchlist })],
  ['home (no data)', state({ currentScreen: 'home' })],
  ['home (demo)', state({ currentScreen: 'home', portfolio, watchlist, mode: 'DEMO' })],
  ['portfolio', state({ currentScreen: 'portfolio', portfolio })],
  ['market', state({ currentScreen: 'market', market: stats })],
  ['watchlist', state({ currentScreen: 'watchlist', watchlist, listIndex: 1 })],
  ['insight', state({ currentScreen: 'insight', lastReply: longReply })],
  ['insight scrolled', state({ currentScreen: 'insight', lastReply: longReply, scroll: 3 })],
  ['proposal (reject selected)', state({ currentScreen: 'proposal', activeProposal: proposal(), voiceState: 'AWAITING_APPROVAL' })],
  ['proposal (approve selected)', state({ currentScreen: 'proposal', activeProposal: proposal({ orderType: 'LIMIT', price: '59000.5', quantity: '0.001', quoteOrderQty: undefined as never }), approvalChoice: 'APPROVE' })],
  ['proposal with warning', state({ currentScreen: 'proposal', activeProposal: proposal({ warnings: ['Quantity rounded down to 0.00123 (lot step 0.00001).'] }) })],
  ['cancel order', state({ currentScreen: 'cancel', pendingCancel: { order: { ...executeResult().order!, status: 'NEW', executedQuantity: '0.0001' }, price: '50000', openCount: 3, done: false } })],
  ['cancel order (done)', state({ currentScreen: 'cancel', pendingCancel: { order: { ...executeResult().order!, status: 'CANCELED' }, price: '50000', openCount: 1, done: true } })],
  ['result', state({ currentScreen: 'result', lastResult: executeResult() })],
  ['result (unverified)', state({ currentScreen: 'result', lastResult: executeResult({ order: null, message: 'Order status is being verified.' }) })],
  ['error', state({ currentScreen: 'error', lastError: 'Binance Testnet is unavailable right now.' })],
  ['listening', state({ voiceState: 'LISTENING' })],
  ['processing', state({ voiceState: 'PROCESSING' })],
];

describe('G2 screens fit the display and its font', () => {
  it.each(screens)('%s: ASCII only, <= 6 body lines, short header/footer', (_name, s) => {
    const v = renderScreen(s);
    const all = [v.header, ...v.body, v.footer].join('\n');
    expect([...all].every((c) => c === '\n' || (c >= ' ' && c <= '~'))).toBe(true);
    expect(v.body.length).toBeLessThanOrEqual(BODY_LINES);
    expect(v.header.length).toBeLessThanOrEqual(40);
    for (const line of v.body) expect(line.length).toBeLessThanOrEqual(56);
    expect(v.footer.length).toBeLessThanOrEqual(62);
    expect(v.header.trim().length).toBeGreaterThan(0);
  });

  it('total text stays far below the 1000-character container limit', () => {
    for (const [, s] of screens) {
      const v = renderScreen(s);
      expect(v.body.join('\n').length).toBeLessThan(450);
    }
  });
});

describe('screen content', () => {
  it('home shows the real portfolio value, change and testnet label', () => {
    const v = renderScreen(state({ currentScreen: 'home', portfolio, watchlist }));
    const text = v.body.join('\n');
    expect(text).toContain('123,456.78 USDT');
    expect(text).toContain('+0.40%');
    expect(v.header).toContain('TESTNET');
  });
  it('shows an honest empty state instead of inventing numbers', () => {
    const text = renderScreen(state({ currentScreen: 'home' })).body.join('\n');
    expect(text).toContain('unavailable');
    expect(text).not.toMatch(/\d{2,},\d{3}/);
  });
  it('demo mode is always labelled', () => {
    expect(renderScreen(state({ currentScreen: 'home', portfolio, mode: 'DEMO' })).header).toContain('DEMO');
    expect(renderScreen(state({ currentScreen: 'home', portfolio, mode: 'DEMO' })).header).not.toContain('TESTNET');
  });
  it('proposal shows exact terms, the testnet banner and defaults to REJECT', () => {
    const v = renderScreen(state({ currentScreen: 'proposal', activeProposal: proposal() }));
    const text = v.body.join('\n');
    expect(v.header).toContain('TESTNET');
    expect(text).toContain('BUY BTC');
    expect(text).toContain('BTCUSDT');
    expect(text).toContain('20 USDT');
    expect(text).toContain('MARKET');
    expect(text).toContain('> REJECT <');
    expect(text).not.toContain('> APPROVE <');
  });
  it('result never claims success without an exchange confirmation', () => {
    const unconfirmed = renderScreen(state({ currentScreen: 'result', lastResult: executeResult({ order: null, message: 'Order status is being verified.' }) }));
    expect(unconfirmed.header).toContain('PENDING');
    expect(unconfirmed.body.join(' ')).not.toMatch(/success|bought|filled/i);
    const confirmed = renderScreen(state({ currentScreen: 'result', lastResult: executeResult() }));
    expect(confirmed.header).toContain('CONFIRMED');
    expect(confirmed.body.join('\n')).toContain('BINANCE ORDER #123456');
  });
  it('insight leaves facts plain and always labels AI interpretation and unverified claims', () => {
    const lines = renderScreen(state({ currentScreen: 'insight', lastReply: longReply })).body.join('\n') + renderScreen(state({ currentScreen: 'insight', lastReply: longReply, scroll: 3 })).body.join('\n');
    expect(lines).not.toContain('FACT:');
    expect(lines).toMatch(/^BTCUSDT last price/);
    expect(lines).toContain('AI VIEW:');
    expect(lines).toContain('UNVERIFIED:');
  });
  it('keeps the testnet tag on answer screens', () => {
    expect(renderScreen(state({ currentScreen: 'insight', lastReply: longReply })).header).toContain('TESTNET');
  });
  it('a resting order says it is waiting, not filled', () => {
    const base = executeResult();
    const v = renderScreen(state({ currentScreen: 'result', lastResult: executeResult({ proposal: proposal({ orderType: 'LIMIT', price: '70500' }), order: { ...base.order!, side: 'SELL', status: 'NEW', executedQuantity: '0' } }) }));
    expect(v.header).toBe('ORDER RESULT  OPEN');
    expect(v.body).toContain('WAITING TO FILL');
    expect(v.body.join('\n')).toMatch(/AT 70,500\.00 USDT/);
    expect(v.body.join(' ')).not.toMatch(/sold|bought/i);
  });
  it('a confirmed fill is four short lines', () => {
    const v = renderScreen(state({ currentScreen: 'result', lastResult: executeResult() }));
    expect(v.body.length).toBe(4);
    expect(v.body[0]).toMatch(/^BOUGHT [\d.,]+ BTC$/);
    expect(v.body[1]).toMatch(/^AT [\d.,]+ USDT$/);
  });
  it('shows thinking, not the previous screen, while a reply is still loading', () => {
    expect(renderScreen(state({ currentScreen: 'market', market: stats, voiceState: 'RESPONDING' })).header).toBe('THINKING');
  });
  it('marks stale data', () => {
    const text = renderScreen(state({ currentScreen: 'portfolio', portfolio: { ...portfolio, fresh: false, ageMs: 90_000 } })).footer;
    expect(text).toContain('STALE');
  });
});

describe('text helpers', () => {
  it('replaces non-ASCII, clips and wraps', () => {
    expect(ascii('BTC → ‘x’ … €')).toBe("BTC > 'x' ... ?");
    expect(clip('abcdefghij', 6)).toBe('abcd..');
    expect(wrap('one two three four five six', 9)).toEqual(['one two', 'three', 'four five', 'six']);
    expect(wrap('', 10)).toEqual(['']);
    expect(wrap('x'.repeat(25), 10).every((l) => l.length <= 10)).toBe(true);
  });
});
