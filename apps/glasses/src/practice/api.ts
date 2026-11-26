import {
  dec, money, parseIntent, pct, price, qty,
  type AgentReply, type ExchangeOrderDto, type ExecuteResult, type MarketStats, type Memory, type ParsedParams, type PlanAlert,
  type Portfolio, type TradePlan, type TradeProposal, type Watchlist,
} from '@pulse/shared';
import { ApiRequestError, type PulseApi } from '../services/api';

/**
 * PRACTICE MODE: the whole app with no server, no keys and no network. Prices are SAMPLE prices that move on a
 * clock, the account is made up and orders are simulated; every screen is labelled DEMO. It is only ever entered
 * by an explicit choice of the wearer. Speech needs the real server, so requests are chosen from a list or typed.
 * It understands the same phrases as the backend (shared parser) and keeps the same approval rules.
 */
const PAIRS = { BTC: 60000, ETH: 3000, SOL: 150, BNB: 600 } as const;
type Asset = keyof typeof PAIRS;
const CHANGE: Record<Asset, number> = { BTC: 2.4, ETH: -1.1, SOL: 4.2, BNB: 0.5 };
const SWING = 0.025; // sample prices swing 2.5% each way ...
const PERIOD_MS = 120_000; // ... every two minutes, so a "drops 2 percent" plan can be watched firing
const MIN_USDT = '5';
const PROPOSAL_MS = 120_000;
const QUOTE = 'USDT';

const isAsset = (a: string | undefined): a is Asset => a !== undefined && a in PAIRS;
const baseOf = (symbol: string) => symbol.replace(/USDT$/, '') as Asset;
const uuid = () => 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
const fail = (message: string, code = 'PRACTICE', status = 422): never => { throw new ApiRequestError(status, code, message); };
const reply = (r: Partial<AgentReply> & Pick<AgentReply, 'intent' | 'response'>): AgentReply => ({
  sections: [], evidence: [], requiresClarification: false, source: 'deterministic', ...r,
});
const says = (intent: AgentReply['intent'], text: string, extra: Partial<AgentReply> = {}) => reply({ intent, response: text, sections: [{ label: 'INFO', text }], ...extra });
const lines = (intent: AgentReply['intent'], texts: string[], extra: Partial<AgentReply> = {}) =>
  reply({ intent, response: texts.join(' '), sections: texts.map((text) => ({ label: 'INFO' as const, text })), ...extra });

export class PracticeApi implements PulseApi {
  lastError: string | null = null;
  lastRequestId: string | null = null;
  private readonly start: number;
  private balances: Record<string, { free: string; locked: string }> = {
    USDT: { free: '1000', locked: '0' }, BTC: { free: '0.05', locked: '0' }, ETH: { free: '0.5', locked: '0' }, SOL: { free: '4', locked: '0' },
  };
  private watch: Asset[] = ['BTC', 'ETH', 'SOL'];
  private proposals = new Map<string, TradeProposal>();
  private results = new Map<string, ExecuteResult>();
  private orders: Array<ExchangeOrderDto & { price: string | null }> = [];
  private armed: TradePlan[] = [];
  private notes: Memory[] = [];
  private sessionId: string | null = null;
  private baseline = '0';
  private trades: string[] = [];
  private lastBuy: string | null = null;
  private orderNo = 1000;

  constructor(private readonly now: () => number = Date.now) {
    this.start = now();
  }

  newIdempotencyKey = () => `practice-${uuid()}`;

  // ------------------------------------------------------------- sample market
  private priceOf(a: Asset): string {
    const phase = ((this.now() - this.start) / PERIOD_MS) * 2 * Math.PI;
    return (PAIRS[a] * (1 + SWING * Math.sin(phase))).toFixed(2);
  }
  private iso = (offset = 0) => new Date(this.now() + offset).toISOString();
  private fresh = () => ({ source: 'practice-sample', timestamp: this.iso(), ageMs: 0, fresh: true });
  private total(asset: string): string {
    const b = this.balances[asset] ?? { free: '0', locked: '0' };
    return dec.fmt(dec.add(dec.parse(b.free), dec.parse(b.locked)));
  }
  private value(asset: string): bigint {
    const unit = isAsset(asset) ? this.priceOf(asset) : '1';
    return dec.mul(dec.parse(this.total(asset)), dec.parse(unit));
  }
  private move(asset: string, free: bigint, locked: bigint = dec.ZERO) {
    const b = this.balances[asset] ?? { free: '0', locked: '0' };
    this.balances[asset] = { free: dec.fmt(dec.add(dec.parse(b.free), free)), locked: dec.fmt(dec.add(dec.parse(b.locked), locked)) };
  }

  // ------------------------------------------------------------- session / health
  health = async () => ({ status: 'ok' as const, database: 'connected' as const, exchange: 'available' as const, environment: 'testnet' as const });
  private auth = () => ({ accessToken: 'practice', expiresAt: this.iso(12 * 3600_000), user: { id: uuid(), displayName: 'Practice' } });
  pair = async () => this.auth();
  refresh = async () => this.auth();
  session = async () => ({ expiresAt: this.iso(12 * 3600_000), user: { id: uuid(), displayName: 'Practice' } });
  logout = async () => ({ loggedOut: true });
  demoReset = async () => ({ proposalsClosed: 0, sessionsRemoved: 0, watchlistReset: false });
  diagnostics = async () => ({
    database: { status: 'unavailable' as const, latencyMs: null },
    exchange: { status: 'available' as const, environment: 'testnet' as const, latencyMs: 0, lastUpdate: this.iso(), mode: 'DEMO' as const },
    ai: { provider: 'practice (no model)', configured: false },
    stt: { provider: 'needs the server', configured: false },
    serverTime: this.iso(),
  });
  memories = async () => [...this.notes];
  deleteMemory = async (id: string) => {
    this.notes = this.notes.filter((m) => m.id !== id);
    return { deleted: true };
  };
  transcribe = async (): Promise<{ text: string; provider: string }> => fail('Speech needs the PULSE server. Pick or type a request.', 'STT_UNAVAILABLE', 503);

  startSession = async () => {
    this.sessionId = uuid();
    this.trades = [];
    const p = await this.portfolio();
    this.baseline = p.totalValueUsdt;
    return { session: { id: this.sessionId, startedAt: this.iso(), endedAt: null, summary: null, status: 'active' }, greeting: await this.greeting() };
  };
  endSession = async (id: string) => ({ id, startedAt: this.iso(), endedAt: this.iso(), summary: this.summary(), status: 'ended' });
  private summary = () => (this.trades.length ? `Trades: ${this.trades.join(', ')}.` : 'No trades.');
  private async greeting(): Promise<AgentReply> {
    const p = await this.portfolio();
    const text = [
      ...(this.notes.length ? [`I remember: ${this.notes.map((m) => m.content).join('; ')}`] : []),
      'Practice mode: sample prices, nothing is real.',
      `Portfolio ~${money(p.totalValueUsdt)} USDT.`,
    ];
    return lines('START_SESSION', text, { uiAction: { type: 'NAVIGATE', screen: 'home' }, data: { mode: 'DEMO' } });
  }

  // ------------------------------------------------------------- data
  portfolio = async (): Promise<Portfolio> => {
    const rows = Object.keys(this.balances)
      .filter((a) => this.total(a) !== '0')
      .map((asset) => ({ asset, free: this.balances[asset]!.free, locked: this.balances[asset]!.locked, total: this.total(asset), v: this.value(asset) }))
      .sort((a, b) => dec.cmp(b.v, a.v));
    const sum = rows.reduce((n, r) => dec.add(n, r.v), dec.ZERO);
    const biggest = rows[0];
    return {
      environment: 'TESTNET', totalValueUsdt: dec.fmtFixed(sum, 2), change24hPercent: '1.20', change24hCoverage: 'sample',
      balances: rows.map(({ v, ...r }) => ({ ...r, valueUsdt: dec.fmtFixed(v, 2), valuationSource: 'practice sample' })),
      coverage: { priced: rows.length, unpriced: 0, total: rows.length, shown: rows.length },
      biggestHolding: biggest ? { asset: biggest.asset, valueUsdt: dec.fmtFixed(biggest.v, 2) } : null,
      ...this.fresh(),
    };
  };
  stats = async (symbol: string): Promise<MarketStats> => {
    const a = baseOf(symbol);
    if (!isAsset(a)) fail(`${symbol} is not in the practice market.`, 'UNKNOWN_SYMBOL', 404);
    return {
      symbol, lastPrice: this.priceOf(a), priceChangePercent: CHANGE[a].toFixed(2), highPrice: (PAIRS[a] * (1 + SWING)).toFixed(2),
      lowPrice: (PAIRS[a] * (1 - SWING)).toFixed(2), volume: '1000', quoteVolume: '1000000', ...this.fresh(),
    };
  };
  watchlist = async (): Promise<Watchlist> => ({
    items: this.watch.map((a, position) => ({ symbol: `${a}${QUOTE}`, position, price: this.priceOf(a), change24hPercent: CHANGE[a].toFixed(2), fresh: true })),
    timestamp: this.iso(),
  });

  // ------------------------------------------------------------- orders (simulated)
  private prepare(sessionId: string, a: Asset, p: ParsedParams, notes: string[] = []): TradeProposal {
    const side = p.side!;
    const ref = this.priceOf(a);
    const limit = p.orderType === 'LIMIT' && p.price ? p.price : undefined;
    const px = dec.parse(limit ?? ref);
    const step = dec.parse('0.00001');
    let quantity = p.quantity;
    if (p.fraction) {
      quantity = dec.fmt(dec.floorToStep(dec.mul(dec.parse(this.balances[a]?.free ?? '0'), dec.parse(p.fraction)), step));
      notes = [...notes, `SHARE OF YOUR ${qty(this.balances[a]?.free ?? '0')} ${a}`];
    }
    // A limit order, or a quantity, is expressed in the asset; a market order may be expressed in USDT.
    if (!quantity && limit) quantity = dec.fmt(dec.floorToStep(dec.div(dec.parse(p.quote!), px), step));
    const quoteOrderQty = quantity ? undefined : p.quote!;
    const total = quantity ? dec.mul(dec.parse(quantity), px) : dec.parse(quoteOrderQty!);
    if (dec.lt(total, dec.parse(MIN_USDT))) fail(`The smallest order is ${MIN_USDT} ${QUOTE}.`);
    const spend = side === 'BUY' ? QUOTE : a;
    const need = side === 'BUY' ? total : quantity ? dec.parse(quantity) : dec.div(total, px);
    if (dec.gt(need, dec.parse(this.balances[spend]?.free ?? '0'))) fail(`Insufficient ${spend} in the practice account.`);
    const proposal: TradeProposal = {
      id: uuid(), userId: uuid(), sessionId, environment: 'TESTNET', symbol: `${a}${QUOTE}`, side, orderType: limit ? 'LIMIT' : 'MARKET',
      ...(quantity ? { quantity } : {}), ...(quoteOrderQty ? { quoteOrderQty } : {}), ...(limit ? { price: limit } : {}),
      referencePrice: ref, estimatedTotal: dec.fmtFixed(total, 2), estimatedFee: '0.0000', quoteAsset: QUOTE, baseAsset: a,
      warnings: notes.length ? notes : ['DEMO: NOTHING IS SENT'], status: 'PENDING_APPROVAL', proposalHash: uuid(),
      expiresAt: this.iso(PROPOSAL_MS), createdAt: this.iso(),
    };
    for (const old of this.proposals.values()) if (old.status === 'PENDING_APPROVAL') old.status = 'EXPIRED';
    this.proposals.set(proposal.id, proposal);
    return { ...proposal };
  }
  private find(id: string): TradeProposal {
    const p = this.proposals.get(id) ?? fail('Trade proposal not found.', 'PROPOSAL_NOT_FOUND', 404);
    if (p.status === 'PENDING_APPROVAL' && Date.parse(p.expiresAt) <= this.now()) p.status = 'EXPIRED';
    return p;
  }
  proposal = async (id: string) => ({ ...this.find(id) });
  approve = async (id: string, body: { sessionId: string; proposalHash: string }) => {
    const p = this.find(id);
    if (p.status !== 'PENDING_APPROVAL') fail('This proposal is no longer awaiting approval.', 'INVALID_STATE', 409);
    if (p.proposalHash !== body.proposalHash || p.sessionId !== body.sessionId) fail('The proposal changed. Review it again.', 'PROPOSAL_CHANGED', 409);
    p.status = 'APPROVED';
    return { ...p };
  };
  reject = async (id: string) => {
    const p = this.find(id);
    if (p.status !== 'PENDING_APPROVAL') fail('This proposal cannot be rejected.', 'INVALID_STATE', 409);
    p.status = 'REJECTED';
    this.trades.push('1 rejected');
    return { ...p };
  };
  execute = async (id: string): Promise<ExecuteResult> => {
    const done = this.results.get(id);
    if (done) return done; // never twice
    const p = this.find(id);
    if (p.status !== 'APPROVED') fail('This trade has not been approved.', 'APPROVAL_REQUIRED', 409);
    const a = p.baseAsset as Asset;
    const market = this.priceOf(a);
    const px = dec.parse(p.price ?? market);
    const quantity = p.quantity ? dec.parse(p.quantity) : dec.floorToStep(dec.div(dec.parse(p.quoteOrderQty!), px), dec.parse('0.00001'));
    const total = dec.mul(quantity, px);
    const fills = p.orderType === 'MARKET' || (p.side === 'BUY' ? dec.gte(px, dec.parse(market)) : dec.lte(px, dec.parse(market)));
    const [spend, amount] = p.side === 'BUY' ? [QUOTE, total] : [a, quantity];
    if (dec.gt(amount, dec.parse(this.balances[spend]?.free ?? '0'))) fail(`Insufficient ${spend} in the practice account.`);
    if (!fills) this.move(spend, -amount, amount);
    else if (p.side === 'BUY') { this.move(QUOTE, -total); this.move(a, quantity); }
    else { this.move(a, -quantity); this.move(QUOTE, total); }
    const order: ExchangeOrderDto & { price: string | null } = {
      id: uuid(), proposalId: id, symbol: p.symbol, side: p.side, orderType: p.orderType, status: fills ? 'FILLED' : 'NEW',
      exchangeOrderId: `D${++this.orderNo}`, clientOrderId: `practice-${this.orderNo}`, originalQuantity: dec.fmt(quantity),
      executedQuantity: fills ? dec.fmt(quantity) : '0', quoteQuantity: fills ? dec.fmt(total) : '0', averagePrice: fills ? dec.fmt(px) : null,
      confirmed: true, environment: 'TESTNET', updatedAt: this.iso(), price: p.price ?? null,
    };
    this.orders.unshift(order);
    p.status = fills ? 'FILLED' : 'SUBMITTED';
    if (fills) this.trades.push('1 filled');
    if (fills && p.side === 'BUY' && p.quoteOrderQty) this.lastBuy = p.quoteOrderQty;
    const result = { proposal: { ...p }, order, message: fills ? 'Simulated fill. Nothing was sent anywhere.' : 'Simulated order waiting to fill.' };
    this.results.set(id, result);
    return result;
  };
  private open = () => this.orders.filter((o) => o.status === 'NEW');
  cancelOrder = async (orderId: string): Promise<ExchangeOrderDto> => {
    const o = this.orders.find((x) => x.id === orderId) ?? fail('Order not found.', 'ORDER_NOT_FOUND', 404);
    if (o.status !== 'NEW') fail('This order is not open.', 'ORDER_NOT_OPEN', 409);
    const a = baseOf(o.symbol);
    const amount = o.side === 'BUY' ? dec.mul(dec.parse(o.originalQuantity!), dec.parse(o.price!)) : dec.parse(o.originalQuantity!);
    this.move(o.side === 'BUY' ? QUOTE : a, amount, -amount);
    o.status = 'CANCELED';
    this.trades.push('1 cancelled');
    return { ...o };
  };

  // ------------------------------------------------------------- plans
  plans = async () => [...this.armed];
  private label = (p: TradePlan) => `${baseOf(p.symbol)} ${p.direction.toLowerCase()} ${price(p.triggerPrice)}`;
  checkPlans = async (sessionId: string) => {
    const busy = [...this.proposals.values()].some((p) => p.status === 'PENDING_APPROVAL' && Date.parse(p.expiresAt) > this.now());
    const met = this.armed.find((p) => {
      const now = dec.parse(this.priceOf(baseOf(p.symbol)));
      const reached = p.direction === 'ABOVE' ? dec.gte(now, dec.parse(p.triggerPrice)) : dec.lte(now, dec.parse(p.triggerPrice));
      return reached && !(busy && p.side);
    });
    if (!met) return { alerts: [] as PlanAlert[], armed: this.armed.length };
    this.armed = this.armed.filter((p) => p.id !== met.id);
    const a = baseOf(met.symbol);
    const plan: TradePlan = { ...met, status: 'TRIGGERED', triggeredAt: this.iso(), observedPrice: this.priceOf(a) };
    let proposal: TradeProposal | null = null;
    let note = 'No order attached.';
    if (plan.side) {
      try {
        proposal = this.prepare(sessionId, a, {
          side: plan.side, orderType: 'MARKET', ...(plan.quoteOrderQty ? { quote: plan.quoteOrderQty } : {}),
          ...(plan.quantity ? { quantity: plan.quantity } : {}), ...(plan.sellFraction ? { fraction: plan.sellFraction } : {}),
        }, [`PLAN: ${this.label(plan)} reached`]);
        note = 'Your order is ready for approval.';
      } catch (err) {
        note = `Could not prepare the order: ${(err as Error).message}`;
      }
    }
    return { alerts: [{ plan, proposal, message: `Plan fired: ${this.label(plan)}. ${note}`, note }], armed: this.armed.length };
  };

  // ------------------------------------------------------------- requests
  message = async (body: { sessionId: string; text: string; displayedProposalId?: string }): Promise<AgentReply> => {
    const { intent, params: p } = parseIntent(body.text);
    try {
      return await this.answer(intent, p, body);
    } catch (err) {
      if (err instanceof ApiRequestError) return says(intent, err.message);
      throw err;
    }
  };

  private asset(p: ParsedParams): Asset {
    if (!isAsset(p.asset)) fail('Practice mode knows Bitcoin, Ethereum, Solana and BNB.');
    return p.asset as Asset;
  }

  private async answer(intent: AgentReply['intent'], p: ParsedParams, body: { sessionId: string; text: string; displayedProposalId?: string }): Promise<AgentReply> {
    const shown = body.displayedProposalId ? this.proposals.get(body.displayedProposalId) : undefined;
    const pending = shown?.status === 'PENDING_APPROVAL' ? shown : undefined;
    switch (intent) {
      case 'START_SESSION':
        return this.greeting();
      case 'END_SESSION':
        return says(intent, `Session ended. ${this.summary()}`, { data: { ended: true } });
      case 'GET_PORTFOLIO':
        return says(intent, 'Your practice portfolio.', { uiAction: { type: 'NAVIGATE', screen: 'portfolio' } });
      case 'GET_BALANCE':
        return says(intent, `${p.asset}: ${qty(this.total(p.asset ?? ''))} total.`);
      case 'GET_MARKET_PRICE':
      case 'GET_MARKET_CHANGE': {
        const symbol = `${this.asset(p)}${QUOTE}`;
        return says(intent, `${symbol} ${price(this.priceOf(this.asset(p)))}.`, { uiAction: { type: 'NAVIGATE', screen: 'market' }, data: { symbol } });
      }
      case 'GET_WATCHLIST':
        return says(intent, 'Your watchlist.', { uiAction: { type: 'NAVIGATE', screen: 'watchlist' } });
      case 'ADD_WATCHLIST_ASSET':
      case 'REMOVE_WATCHLIST_ASSET': {
        const a = this.asset(p);
        this.watch = this.watch.filter((x) => x !== a);
        if (intent === 'ADD_WATCHLIST_ASSET') this.watch.push(a);
        return says(intent, 'Watchlist updated.', { uiAction: { type: 'NAVIGATE', screen: 'watchlist' } });
      }
      case 'SAVE_MEMORY': {
        if (!p.memory?.content) return says(intent, 'What should I remember?');
        const at = this.iso();
        this.notes.push({ id: uuid(), category: p.memory.category, content: p.memory.content, source: 'user_explicit', verification: 'user_confirmed', confidence: null, createdAt: at, updatedAt: at, expiresAt: null });
        return says(intent, `Saved: ${p.memory.content}`);
      }
      case 'GET_ORDER_STATUS': {
        const o = this.orders[0];
        return says(intent, o ? `Last order: ${o.side} ${o.symbol}, ${o.status}.` : 'You have no orders yet.');
      }
      case 'GET_SESSION_PNL': {
        const now = (await this.portfolio()).totalValueUsdt;
        const diff = dec.sub(dec.parse(now), dec.parse(this.baseline));
        const share = dec.fmtFixed(dec.pctChange(dec.parse(this.baseline), dec.parse(now)), 2);
        return lines(intent, [
          `Session P&L: ${dec.lt(diff, dec.ZERO) ? '' : '+'}${money(dec.fmtFixed(diff, 2))} USDT (${share === '0.00' || share === '-0.00' ? '0.00%' : pct(share)}).`,
          `From ${money(this.baseline)} to ${money(now)} USDT.`,
        ]);
      }
      case 'CREATE_PLAN': {
        if (p.missing?.length || !p.plan) return says(intent, 'Say the asset and level, e.g. "alert me if Bitcoin drops 2 percent".');
        const a = this.asset(p);
        if (this.armed.length >= 5) return says(intent, 'You already have 5 plans armed. Cancel one first.');
        const ref = this.priceOf(a);
        const factor = dec.parse(p.plan.direction === 'ABOVE' ? '1' : '-1');
        const trigger = p.plan.price ?? dec.fmtFixed(dec.add(dec.parse(ref), dec.mul(factor, dec.div(dec.mul(dec.parse(ref), dec.parse(p.plan.percent!)), dec.parse('100')))), 2);
        const plan: TradePlan = {
          id: uuid(), symbol: `${a}${QUOTE}`, direction: p.plan.direction, triggerPrice: trigger, referencePrice: ref, side: p.side ?? null,
          quoteOrderQty: p.side ? p.quote ?? null : null, quantity: p.side ? p.quantity ?? null : null, sellFraction: p.side ? p.fraction ?? null : null,
          status: 'ARMED', createdAt: this.iso(), expiresAt: this.iso(24 * 3600_000), triggeredAt: null, observedPrice: null, hitAt: null, hitPrice: null,
        };
        this.armed.push(plan);
        return lines(intent, [
          `Plan armed: ${this.label(plan)}.`, `Now ${price(ref)}.`,
          plan.side ? 'The order will wait for your approval.' : 'Alert only. No order attached.',
        ], { data: { planArmed: true } });
      }
      case 'GET_PLANS':
        return lines(intent, this.armed.length ? this.armed.map(this.label) : ['No plans armed.']);
      case 'CANCEL_PLAN': {
        const gone = this.armed.filter((x) => !p.asset || x.symbol === `${p.asset}${QUOTE}`);
        this.armed = this.armed.filter((x) => !gone.includes(x));
        return says(intent, gone.length ? `Cancelled: ${gone.map(this.label).join(', ')}.` : 'There was no plan to cancel.');
      }
      case 'PREPARE_TRADE': {
        let params = p;
        const notes: string[] = [];
        if (p.side === 'BUY' && p.missing?.length === 1 && p.missing[0] === 'amount' && this.lastBuy) {
          params = { ...p, quote: this.lastBuy, missing: [] };
          notes.push(`SMART DEFAULT: your last ${this.lastBuy} USDT`);
        }
        if (params.missing?.length) return says(intent, 'Say how much, e.g. "buy 20 dollars of Bitcoin".');
        const proposal = this.prepare(body.sessionId, this.asset(params), params, notes);
        return says(intent, 'Review and approve on the lens.', { uiAction: { type: 'SHOW_PROPOSAL', proposal } });
      }
      case 'APPROVE_TRADE':
        return pending
          ? says(intent, 'Approving (practice).', { uiAction: { type: 'APPROVE_PROPOSAL', proposalId: pending.id, proposalHash: pending.proposalHash } })
          : says(intent, 'Nothing is waiting for approval.');
      case 'REJECT_TRADE':
      case 'CANCEL_ORDER': {
        if (pending) {
          await this.reject(pending.id);
          return says('REJECT_TRADE', 'Proposal cancelled. Nothing was sent.', { uiAction: { type: 'REJECT_PROPOSAL', proposalId: pending.id } });
        }
        const open = this.open().filter((o) => !p.asset || o.symbol === `${p.asset}${QUOTE}`);
        const target = open[0];
        if (!target) return says('CANCEL_ORDER', 'No open order to cancel.');
        const { price: limit, ...order } = target;
        return says('CANCEL_ORDER', 'Confirm on the lens.', { uiAction: { type: 'CONFIRM_CANCEL', order, price: limit, openCount: open.length } });
      }
      case 'GET_OPEN_ORDERS':
        return lines(intent, this.open().length ? this.open().map((o) => `${o.side} ${qty(o.originalQuantity!)} ${baseOf(o.symbol)} at ${price(o.price!)}`) : ['No open orders.']);
      case 'ASK_FINANCIAL_QUESTION': {
        const a = isAsset(p.asset) ? p.asset : 'BTC';
        return reply({
          intent, response: 'Practice answer.',
          sections: [
            ...(p.advice ? [{ label: 'INFO' as const, text: 'No financial advice. Sample facts only.' }] : []),
            { label: 'FACT', text: `${a} sample price ${price(this.priceOf(a))}.` },
            { label: 'FACT', text: `${a} 24h ${pct(CHANGE[a].toFixed(2))} (sample).` },
            { label: 'UNVERIFIED', text: 'Cannot verify why: no news source.' },
          ],
        });
      }
      default:
        return says('GET_HELP', 'Try: "how is my session", "buy 20 dollars of bitcoin", "sell half my bitcoin" or "cancel my order".');
    }
  }
}
