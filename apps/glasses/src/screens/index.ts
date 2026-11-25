import { money, pct, price, qty, type AgentReply } from '@pulse/shared';
import type { GlassesView } from '../sdk/types';
import type { PulseState } from '../state/types';
import { BODY_LINES, LINE, ascii, clip, twoCol, wrap } from '../utils/text';

/**
 * Pure state -> view renderers. Rules: one thing that matters per screen, <= 6 short lines, ASCII only,
 * hierarchy by case/spacing/brightness (header brightest, footer dimmest), never colour.
 * No financial maths happens here: every number is a string the backend produced.
 */
const sym = (s: string) => s.replace(/(USDT|USDC)$/, '');
const arrow = (p: string | null) => (p === null ? ' ' : p.startsWith('-') ? 'v' : '^');
const age = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s`;
const tag = (s: PulseState) => (s.mode === 'DEMO' ? 'DEMO' : 'TESTNET');

export function greeting(now: number): string {
  const h = new Date(now).getHours();
  return h < 5 ? 'GOOD NIGHT' : h < 12 ? 'GOOD MORNING' : h < 18 ? 'GOOD AFTERNOON' : 'GOOD EVENING';
}

function hint(s: PulseState, fallback: string): string {
  switch (s.voiceState) {
    case 'LISTENING': return 'LISTENING... DBL-TAP: SEND  HOLD: CANCEL';
    case 'PROCESSING': return 'THINKING...';
    case 'ERROR': return clip(s.lastError ?? 'ERROR', 50);
    default: return fallback;
  }
}

function connection(s: PulseState): GlassesView {
  const word = (v: string) => (v === 'ok' ? 'OK' : v === 'down' ? 'DOWN' : '...');
  const auth = s.authenticationStatus === 'authenticated' ? 'OK' : s.authenticationStatus === 'pairing' ? 'PAIRING' : 'REQUIRED';
  const title =
    s.connectionStatus === 'auth_required' ? 'PAIRING REQUIRED'
    : s.connectionStatus === 'offline' ? 'OFFLINE'
    : s.connectionStatus === 'reconnecting' ? 'RECONNECTING'
    : s.connectionStatus === 'exchange_unavailable' ? 'EXCHANGE UNAVAILABLE'
    : 'CONNECTING';
  return {
    header: `PULSE  ${tag(s)}`,
    body: [title, '', twoCol('BACKEND', word(s.backend), 30), twoCol('EXCHANGE', word(s.exchange), 30), twoCol('SESSION', auth, 30),
      ...(s.connectionStatus === 'auth_required' ? ['Enter the pairing code in the app'] : [])].slice(0, BODY_LINES),
    footer: s.lastError ? clip(s.lastError, 50) : 'TAP: RETRY',
  };
}

function home(s: PulseState): GlassesView {
  const p = s.portfolio;
  const w = s.watchlist?.items.filter((i) => i.price).slice(0, 2) ?? [];
  const body = [greeting(s.now), ''];
  if (p) {
    body.push(twoCol('PORTFOLIO', `${money(p.totalValueUsdt)} USDT`, 36));
    body.push(twoCol('TODAY', p.change24hPercent ? pct(p.change24hPercent) : 'n/a', 36));
  } else body.push('PORTFOLIO  unavailable');
  if (w.length) body.push(w.map((i) => `${sym(i.symbol)} ${price(i.price!)}`).join('   '));
  return { header: `PULSE  ${tag(s)}`, body: body.slice(0, BODY_LINES), footer: hint(s, s.notice ? clip(s.notice, 50) : 'DBL-TAP: ASK   SWIPE: NEXT') };
}

function portfolio(s: PulseState): GlassesView {
  const p = s.portfolio;
  if (!p) return { header: 'PORTFOLIO', body: ['No data yet.', 'Double-tap and ask:', '"show my portfolio"'], footer: hint(s, 'TAP: HOME') };
  const start = Math.min(s.listIndex, Math.max(0, p.balances.length - 3));
  const rows = p.balances.slice(start, start + 3).map((b) => twoCol(`${b.asset} ${qty(b.total)}`, b.valueUsdt ? money(b.valueUsdt) : '-', LINE - 4));
  return {
    header: `PORTFOLIO  ${tag(s)}`,
    body: [twoCol('TOTAL', `${money(p.totalValueUsdt)} USDT`, 36), p.change24hPercent ? twoCol('24H', pct(p.change24hPercent), 36) : '24H  n/a', '', ...rows],
    footer: hint(s, `${p.coverage.priced} priced, ${p.coverage.unpriced} unpriced - ${age(p.ageMs)}${p.fresh ? '' : ' STALE'}`),
  };
}

function market(s: PulseState): GlassesView {
  const m = s.market;
  if (!m) return { header: 'MARKET', body: ['Pick an asset:', 'Swipe on WATCHLIST or ask', '"price of bitcoin"'], footer: hint(s, 'TAP: HOME') };
  return {
    header: `${m.symbol}  ${tag(s)}`,
    body: [price(m.lastPrice), twoCol('24H', pct(m.priceChangePercent), 30), '', twoCol('HIGH', price(m.highPrice), 30), twoCol('LOW', price(m.lowPrice), 30)],
    footer: hint(s, `${age(m.ageMs)} ago${m.fresh ? '' : ' - STALE'} - SWIPE: NEXT ASSET`),
  };
}

function watchlist(s: PulseState): GlassesView {
  const items = s.watchlist?.items ?? [];
  if (!items.length) return { header: 'WATCHLIST', body: ['Empty.', 'Say "add SOL to my watchlist"'], footer: hint(s, 'TAP: HOME') };
  const start = Math.max(0, Math.min(s.listIndex - 2, items.length - BODY_LINES));
  const rows = items.slice(start, start + BODY_LINES).map((i, k) => {
    const sel = start + k === s.listIndex ? '>' : ' ';
    const left = `${sel}${sym(i.symbol)}`;
    const right = i.price ? `${price(i.price)} ${arrow(i.change24hPercent)}${i.change24hPercent ? pct(i.change24hPercent) : ''}` : 'n/a';
    return twoCol(left, right, LINE - 4);
  });
  return { header: `WATCHLIST  ${tag(s)}`, body: rows, footer: hint(s, 'SWIPE: MOVE  TAP: OPEN') };
}

const LABEL: Record<AgentReply['sections'][number]['label'], string> = { FACT: 'FACT', AI: 'AI VIEW', UNVERIFIED: 'UNVERIFIED', INFO: '' };

export function insightLines(r: AgentReply): string[] {
  const lines: string[] = [];
  const sections = r.sections.length ? r.sections : [{ label: 'INFO' as const, text: r.response }];
  for (const sec of sections) {
    const label = LABEL[sec.label];
    wrap(label ? `${label}: ${sec.text}` : sec.text, LINE).forEach((l) => lines.push(l));
  }
  return lines;
}

function insight(s: PulseState): GlassesView {
  const r = s.lastReply;
  if (!r) return { header: 'PULSE', body: ['Ask me something.'], footer: hint(s, 'DBL-TAP: ASK') };
  const lines = insightLines(r);
  const max = Math.max(0, lines.length - BODY_LINES);
  const off = Math.min(s.scroll, max);
  const more = lines.length > BODY_LINES ? ` ${off + 1}-${Math.min(lines.length, off + BODY_LINES)}/${lines.length}` : '';
  const title = r.source === 'ai' ? 'ANSWER  (AI)' : r.intent === 'UNKNOWN' ? 'PULSE' : 'ANSWER  (VERIFIED DATA)';
  return { header: title, body: lines.slice(off, off + BODY_LINES), footer: hint(s, `${lines.length > BODY_LINES ? 'SWIPE: SCROLL ' : ''}DBL-TAP: ASK${more}`) };
}

function proposal(s: PulseState): GlassesView {
  const p = s.activeProposal;
  if (!p) return { header: 'TRADE PROPOSAL', body: ['No active proposal.'], footer: 'TAP: HOME' };
  const amount = p.quoteOrderQty ? `${qty(p.quoteOrderQty)} ${p.quoteAsset}` : `${qty(p.quantity!)} ${p.baseAsset}`;
  const px = p.orderType === 'LIMIT' && p.price ? `LIMIT ${price(p.price)}` : `MARKET ~${price(p.referencePrice)}`;
  const left = Math.max(0, Math.round((new Date(p.expiresAt).getTime() - s.now) / 1000));
  const reject = s.approvalChoice === 'REJECT' ? '> REJECT <' : '  REJECT  ';
  const approve = s.approvalChoice === 'APPROVE' ? '> APPROVE <' : '  APPROVE  ';
  return {
    header: `TRADE PROPOSAL  TESTNET`,
    body: [
      `${p.side} ${p.baseAsset}   (${p.symbol})`,
      twoCol('AMOUNT', amount, 34),
      twoCol('PRICE', px, 34),
      twoCol('EST FEE', `${p.estimatedFee ?? '-'} ${p.quoteAsset}`, 34),
      p.warnings[0] ? clip(p.warnings[0], LINE) : 'THIS IS A TESTNET TRADE',
      `${reject}      ${approve}`,
    ],
    footer: hint(s, `SWIPE: CHOOSE  TAP: CONFIRM  ${left}s`),
  };
}

function result(s: PulseState): GlassesView {
  const r = s.lastResult;
  if (!r) return { header: 'ORDER RESULT', body: ['Nothing yet.'], footer: 'TAP: HOME' };
  const o = r.order;
  const body = [...wrap(r.message, LINE).slice(0, 3)];
  if (o) {
    body.push(`${o.side} ${o.symbol}  ${o.status}`);
    if (o.executedQuantity && o.executedQuantity !== '0') body.push(twoCol(`FILLED ${qty(o.executedQuantity)}`, o.averagePrice ? `@ ${price(o.averagePrice)}` : '', 36));
    body.push(o.exchangeOrderId ? `BINANCE ORDER #${o.exchangeOrderId}` : 'NOT CONFIRMED BY EXCHANGE');
  }
  return { header: `ORDER RESULT  ${r.order?.confirmed ? 'CONFIRMED' : 'PENDING'}`, body: body.slice(0, BODY_LINES), footer: hint(s, 'TAP: HOME') };
}

function error(s: PulseState): GlassesView {
  return { header: 'PULSE  ERROR', body: wrap(s.lastError ?? 'Something went wrong.', LINE).slice(0, BODY_LINES), footer: s.retryOrder ? 'TAP: RETRY SAME ORDER  HOLD: HOME' : 'TAP: RETRY   HOLD: HOME' };
}

export function renderScreen(s: PulseState): GlassesView {
  let v: GlassesView;
  if (s.voiceState === 'LISTENING') {
    v = { header: 'LISTENING', body: ['', 'Speak now...', '', 'Double-tap to send', 'Hold to cancel'], footer: 'MIC ON' };
  } else if (s.voiceState === 'PROCESSING') {
    v = { header: 'THINKING', body: ['', 'Checking verified data...'], footer: 'HOLD: CANCEL' };
  } else {
    switch (s.currentScreen) {
      case 'connection': v = connection(s); break;
      case 'home': v = home(s); break;
      case 'portfolio': v = portfolio(s); break;
      case 'market': v = market(s); break;
      case 'watchlist': v = watchlist(s); break;
      case 'insight': v = insight(s); break;
      case 'proposal': v = proposal(s); break;
      case 'result': v = result(s); break;
      default: v = error(s);
    }
  }
  return { header: ascii(v.header), body: v.body.map(ascii), footer: ascii(v.footer) };
}
