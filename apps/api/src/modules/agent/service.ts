import type { AgentReply, Intent, TradeProposal } from '@pulse/shared';
import { AppError } from '../../utils/errors';
import type { AuditService } from '../../security/audit';
import { parseIntent, type ParsedParams } from '../ai/intent-parser';
import type { AIContext, AIProvider, AIResponse, ContextItem } from '../ai/types';
import { tradeParamsSchema, validateAiIntent } from '../ai/validate';
import { ExchangeUnavailableError, ExchangeNotConfiguredError, ExchangeRejectedError } from '../exchange/types';
import type { MarketService } from '../market/service';
import type { WatchlistService } from '../market/watchlist';
import type { MemoryService } from '../memory/service';
import type { PortfolioService } from '../portfolio/service';
import type { AgentSessionService } from '../sessions/agent-sessions';
import { toSessionDto } from '../sessions/agent-sessions';
import type { TradingService } from '../trading/service';
import { money, pct, price, qty } from './format';

export interface AgentDeps {
  market: MarketService;
  portfolio: PortfolioService;
  watchlist: WatchlistService;
  trading: TradingService;
  sessions: AgentSessionService;
  memory: MemoryService;
  ai: AIProvider;
  audit: AuditService;
  mode: 'LIVE' | 'DEMO';
  log?: { warn: (o: object, m?: string) => void };
}

const HELP =
  'Try: "start my trading session", "show my portfolio", "price of Bitcoin", "how is Ether performing", "add SOL to my watchlist", "buy 20 USDT of BTC", then "approve" or "reject". Remember things with "remember that ...".';

const NO_ADVICE = 'PULSE does not give financial advice. Here are verified facts only.';

const reply = (r: Partial<AgentReply> & Pick<AgentReply, 'intent' | 'response'>): AgentReply => ({
  sections: [], evidence: [], requiresClarification: false, source: 'deterministic', ...r,
});

export class AgentService {
  constructor(private readonly d: AgentDeps) {}

  // ------------------------------------------------------------------ session start
  async startSession(userId: string) {
    const session = await this.d.sessions.create(userId);
    this.d.audit.fire({ userId, sessionId: session.id, eventType: 'session.started', resourceType: 'agent_session', resourceId: session.id });
    const greeting = await this.greeting(userId);
    await this.d.sessions.addMessage(session.id, 'assistant', greeting.response, 'START_SESSION');
    return { session: toSessionDto(session), greeting };
  }

  async endSession(userId: string, sessionId: string) {
    const ended = await this.d.sessions.end(userId, sessionId);
    if (ended.summary) await this.d.memory.saveSessionSummary(userId, ended.summary);
    this.d.audit.fire({ userId, sessionId, eventType: 'session.ended', resourceType: 'agent_session', resourceId: sessionId });
    return toSessionDto(ended);
  }

  private async greeting(userId: string): Promise<AgentReply> {
    const sections: AgentReply['sections'] = [];
    const evidence: AgentReply['evidence'] = [];
    const parts: string[] = [];
    try {
      const p = await this.d.portfolio.getPortfolio();
      const line = `Portfolio about ${money(p.totalValueUsdt)} USDT across ${p.coverage.priced} priced assets (testnet)${p.change24hPercent ? `, ${pct(p.change24hPercent)} over 24h` : ''}.`;
      sections.push({ label: 'FACT', text: line });
      evidence.push({ type: 'portfolio', reference: 'portfolio:testnet', value: p.totalValueUsdt, timestamp: p.timestamp });
      parts.push(line);
      const w = await this.d.watchlist.list(userId);
      const movers = w.items.filter((i) => i.price && i.change24hPercent).slice(0, 3);
      if (movers.length) {
        const text = movers.map((m) => `${m.symbol.replace(/USDT$/, '')} ${price(m.price!)} (${pct(m.change24hPercent!)})`).join(', ');
        sections.push({ label: 'FACT', text: `Watchlist: ${text}.` });
        parts.push(`Watchlist: ${text}.`);
      }
    } catch (err) {
      if (!this.isExchangeIssue(err)) throw err;
      const t = 'Binance Testnet is unavailable right now, so I cannot show portfolio values.';
      sections.push({ label: 'INFO', text: t });
      parts.push(t);
    }
    const [last, mems, prefs] = await Promise.all([this.d.sessions.lastEnded(userId), this.d.memory.retrieve(userId, 'preferences goals', 3), this.d.memory.preferences(userId)]);
    if (last?.summary) sections.push({ label: 'INFO', text: `Last session: ${last.summary}` });
    if (mems.length) sections.push({ label: 'INFO', text: `I remember: ${mems.map((m) => m.content).join('; ')}` });
    const tail = last || mems.length ? 'Welcome back. ' : '';
    // Remembered context first: the glasses show only ~6 lines, and this is what makes a returning session feel personal.
    const remembered = sections.filter((s) => s.label === 'INFO' && /^(I remember|Last session)/.test(s.text));
    const ordered = [...remembered, ...sections.filter((s) => !remembered.includes(s))];
    return reply({
      intent: 'START_SESSION', response: `${tail}Your session is ready. ${parts.join(' ')} What would you like to review?`.slice(0, 400),
      sections: ordered, evidence, uiAction: { type: 'NAVIGATE', screen: 'home' }, data: { mode: this.d.mode, memoriesUsed: mems.length, preferences: prefs },
    });
  }

  // ------------------------------------------------------------------ message handling
  async handleMessage(userId: string, req: { sessionId: string; text: string; source: 'voice' | 'text'; displayedProposalId?: string | undefined }): Promise<AgentReply> {
    await this.d.sessions.requireActive(userId, req.sessionId);
    let parsed = parseIntent(req.text);
    let viaAi = false;
    if (parsed.intent === 'UNKNOWN' && this.d.ai.name !== 'deterministic') {
      try {
        const r = await this.d.ai.classifyIntent({ text: req.text });
        const v = validateAiIntent(r);
        if (v && v.intent !== 'UNKNOWN') {
          parsed = { intent: v.intent, params: this.coerceParams(v.params), confidence: v.confidence };
          viaAi = true;
        }
      } catch (err) {
        this.d.log?.warn({ err: err instanceof Error ? err.message : 'unknown' }, 'ai classifyIntent failed; using deterministic path');
      }
    }

    let out: AgentReply;
    const symbols: string[] = [];
    try {
      out = await this.dispatch(userId, req, parsed.intent, parsed.params, symbols);
    } catch (err) {
      out = this.errorReply(parsed.intent, err);
    }
    // Persist both messages in one round trip (explicit timestamps keep their order stable).
    const t = Date.now();
    await Promise.all([
      this.d.sessions.addMessage(req.sessionId, 'user', req.text, parsed.intent, { symbols, source: req.source, viaAi, confidence: parsed.confidence }, new Date(t)),
      this.d.sessions.addMessage(req.sessionId, 'assistant', out.response, parsed.intent, { source: out.source }, new Date(t + 1)),
    ]);
    this.d.audit.fire({ userId, sessionId: req.sessionId, eventType: 'agent.message', resourceType: 'agent_session', resourceId: req.sessionId, metadata: { intent: parsed.intent, source: req.source } });
    return out;
  }

  private coerceParams(p: Record<string, unknown>): ParsedParams {
    const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : undefined);
    const out: ParsedParams = {};
    const asset = s('asset')?.toUpperCase();
    if (asset && /^[A-Z0-9]{2,10}$/.test(asset)) out.asset = asset;
    if (s('side') === 'BUY' || s('side') === 'SELL') out.side = s('side') as 'BUY' | 'SELL';
    for (const k of ['quote', 'quantity', 'price'] as const) {
      const v = s(k);
      if (v && /^\d+(\.\d+)?$/.test(v)) out[k] = v;
    }
    out.orderType = out.price ? 'LIMIT' : 'MARKET';
    return out;
  }

  private isExchangeIssue(err: unknown) {
    return err instanceof ExchangeUnavailableError || err instanceof ExchangeNotConfiguredError || err instanceof ExchangeRejectedError;
  }

  private errorReply(intent: Intent, err: unknown): AgentReply {
    if (err instanceof AppError && err.status < 500) return reply({ intent, response: err.message, sections: [{ label: 'INFO', text: err.message }] });
    if (this.isExchangeIssue(err)) {
      const t = 'Binance Testnet is unavailable right now. I will not guess values; try again in a moment.';
      return reply({ intent, response: t, sections: [{ label: 'INFO', text: t }] });
    }
    throw err;
  }

  private async quoteAsset(userId: string): Promise<string> {
    const prefs = await this.d.memory.preferences(userId);
    const q = prefs.preferred_quote;
    return typeof q === 'string' && /^[A-Z]{3,5}$/.test(q) ? q : 'USDT';
  }

  private async symbolFor(userId: string, asset: string | undefined, symbols: string[]): Promise<string> {
    if (!asset) throw new AppError(422, 'ASSET_REQUIRED', 'Which asset? For example Bitcoin or ETH.');
    const quote = await this.quoteAsset(userId);
    if (asset === quote) throw new AppError(422, 'ASSET_IS_QUOTE', `${asset} is the quote currency; pick another asset.`);
    const info = await this.d.market.requireSymbol(`${asset}${quote}`);
    symbols.push(info.symbol);
    return info.symbol;
  }

  // ------------------------------------------------------------------ dispatch
  private async dispatch(
    userId: string,
    req: { sessionId: string; text: string; displayedProposalId?: string | undefined },
    intent: Intent, p: ParsedParams, symbols: string[],
  ): Promise<AgentReply> {
    switch (intent) {
      case 'START_SESSION':
        return this.greeting(userId);

      case 'END_SESSION': {
        const s = await this.endSession(userId, req.sessionId);
        return reply({ intent, response: `Session ended. ${s.summary ?? ''}`.trim(), sections: [{ label: 'INFO', text: s.summary ?? 'Session ended.' }], uiAction: { type: 'NONE' }, data: { ended: true } });
      }

      case 'GET_HELP':
        return reply({ intent, response: HELP, sections: [{ label: 'INFO', text: HELP }] });

      case 'GET_PORTFOLIO': {
        const pf = await this.d.portfolio.getPortfolio();
        const lines: AgentReply['sections'] = [];
        if (p.detail === 'biggest' && pf.biggestHolding) {
          lines.push({ label: 'FACT', text: `Biggest holding: ${pf.biggestHolding.asset}, about ${money(pf.biggestHolding.valueUsdt)} USDT.` });
        }
        lines.push({ label: 'FACT', text: `Total about ${money(pf.totalValueUsdt)} USDT over ${pf.coverage.priced} priced assets (testnet). ${pf.coverage.unpriced} unpriced assets are excluded.` });
        if (pf.change24hPercent) lines.push({ label: 'FACT', text: `24h change ${pct(pf.change24hPercent)} (${pf.change24hCoverage}).` });
        const top = pf.balances.slice(0, 3).map((b) => `${b.asset} ${money(b.valueUsdt ?? '0')}`).join(', ');
        if (top) lines.push({ label: 'FACT', text: `Top: ${top} USDT.` });
        if (!pf.fresh) lines.push({ label: 'INFO', text: 'This data is stale.' });
        return reply({
          intent, response: lines.map((l) => l.text).join(' ').slice(0, 400), sections: lines,
          evidence: [{ type: 'portfolio', reference: 'portfolio:testnet', value: pf.totalValueUsdt, timestamp: pf.timestamp }],
          uiAction: { type: 'NAVIGATE', screen: 'portfolio' }, data: { mode: this.d.mode },
        });
      }

      case 'GET_BALANCE': {
        const asset = p.asset ?? '';
        const b = await this.d.portfolio.getBalance(asset);
        const text = b.total === '0' ? `You hold no ${b.asset} on testnet.` : `${b.asset}: ${qty(b.total)} total (${qty(b.free)} free, ${qty(b.locked)} locked).`;
        return reply({
          intent, response: text, sections: [{ label: 'FACT', text }, ...(b.fresh ? [] : [{ label: 'INFO' as const, text: 'This data is stale.' }])],
          evidence: [{ type: 'balance', reference: `balance:${b.asset}`, value: b.total, timestamp: b.timestamp }], uiAction: { type: 'NAVIGATE', screen: 'portfolio' },
        });
      }

      case 'GET_MARKET_PRICE': {
        const symbol = await this.symbolFor(userId, p.asset, symbols);
        const t = await this.d.market.getTicker(symbol);
        const text = `${symbol} is ${price(t.price)} (testnet price, ${Math.round(t.ageMs / 1000)}s old${t.fresh ? '' : ', STALE'}).`;
        return reply({
          intent, response: text, sections: [{ label: 'FACT', text }],
          evidence: [{ type: 'ticker', reference: `ticker:${symbol}`, value: t.price, timestamp: t.timestamp }],
          uiAction: { type: 'NAVIGATE', screen: 'market' }, data: { symbol },
        });
      }

      case 'GET_MARKET_CHANGE': {
        const symbol = await this.symbolFor(userId, p.asset, symbols);
        const s = await this.d.market.getStats(symbol);
        const text = `${symbol} ${pct(s.priceChangePercent)} over 24h at ${price(s.lastPrice)}. High ${price(s.highPrice)}, low ${price(s.lowPrice)}.`;
        return reply({
          intent, response: text, sections: [{ label: 'FACT', text }],
          evidence: [{ type: 'stats', reference: `stats:${symbol}`, value: s.priceChangePercent, timestamp: s.timestamp }],
          uiAction: { type: 'NAVIGATE', screen: 'market' }, data: { symbol },
        });
      }

      case 'GET_WATCHLIST': {
        const w = await this.d.watchlist.list(userId);
        const lines = w.items.map((i) => `${i.symbol.replace(/USDT$/, '')} ${i.price ? price(i.price) : 'n/a'}${i.change24hPercent ? ` ${pct(i.change24hPercent)}` : ''}`);
        const text = lines.length ? `Watchlist: ${lines.join(', ')}.` : 'Your watchlist is empty.';
        return reply({ intent, response: text, sections: [{ label: 'FACT', text }], uiAction: { type: 'NAVIGATE', screen: 'watchlist' } });
      }

      case 'ADD_WATCHLIST_ASSET': {
        const symbol = await this.symbolFor(userId, p.asset, symbols);
        const list = await this.d.watchlist.add(userId, symbol);
        const text = `Added ${symbol}. Watchlist: ${list.map((s) => s.replace(/USDT$/, '')).join(', ')}.`;
        return reply({ intent, response: text, sections: [{ label: 'INFO', text }], uiAction: { type: 'NAVIGATE', screen: 'watchlist' } });
      }

      case 'REMOVE_WATCHLIST_ASSET': {
        const symbol = await this.symbolFor(userId, p.asset, symbols);
        const list = await this.d.watchlist.remove(userId, symbol);
        const text = `Removed ${symbol}. Watchlist: ${list.map((s) => s.replace(/USDT$/, '')).join(', ') || 'empty'}.`;
        return reply({ intent, response: text, sections: [{ label: 'INFO', text }], uiAction: { type: 'NAVIGATE', screen: 'watchlist' } });
      }

      case 'SAVE_MEMORY': {
        const m = p.memory;
        if (!m || !m.content) {
          return reply({ intent, response: 'What should I remember? For example: "remember that I focus on BTC and ETH".', requiresClarification: true, sections: [{ label: 'INFO', text: 'What should I remember?' }] });
        }
        const saved = await this.d.memory.create(userId, { category: m.category, content: m.content });
        if (m.preference) await this.d.memory.setPreference(userId, m.preference.key, m.preference.value);
        const text = `Saved: ${saved.content}`;
        return reply({ intent, response: text, sections: [{ label: 'INFO', text }], data: { memoryId: saved.id } });
      }

      case 'GET_ORDER_STATUS': {
        const o = await this.d.trading.lastOrder(userId);
        if (!o) return reply({ intent, response: 'You have no orders yet.', sections: [{ label: 'INFO', text: 'You have no orders yet.' }] });
        const text = `Last order: ${o.side} ${o.symbol}, ${o.status}. ${o.message}`;
        return reply({ intent, response: text.slice(0, 400), sections: [{ label: 'FACT', text }], evidence: [{ type: 'order', reference: `order:${o.id}`, value: o.status, timestamp: o.updatedAt }], data: { orderId: o.id } });
      }

      case 'PREPARE_TRADE':
        return this.prepareTrade(userId, req.sessionId, p, symbols);

      case 'APPROVE_TRADE': {
        // Voice approval is only a TRIGGER: the glasses client must still call the approve endpoint with the hash of what it displayed.
        const proposal = await this.pendingProposal(userId, req.sessionId, req.displayedProposalId);
        if (!proposal) return reply({ intent, response: 'There is nothing waiting for approval.', sections: [{ label: 'INFO', text: 'Nothing is waiting for approval.' }] });
        return reply({
          intent, response: `Approving ${proposal.side} ${proposal.symbol} on testnet.`, sections: [{ label: 'INFO', text: `Approving ${proposal.side} ${proposal.symbol} (testnet).` }],
          uiAction: { type: 'APPROVE_PROPOSAL', proposalId: proposal.id, proposalHash: proposal.proposalHash },
        });
      }

      case 'REJECT_TRADE': {
        const proposal = await this.pendingProposal(userId, req.sessionId, req.displayedProposalId);
        if (!proposal) return reply({ intent, response: 'There is nothing to cancel.', sections: [{ label: 'INFO', text: 'Nothing to cancel.' }] });
        await this.d.trading.reject(userId, proposal.id, req.sessionId);
        return reply({ intent, response: 'Proposal cancelled. Nothing was sent to the exchange.', sections: [{ label: 'INFO', text: 'Proposal cancelled. Nothing was sent to the exchange.' }], uiAction: { type: 'REJECT_PROPOSAL', proposalId: proposal.id } });
      }

      case 'ASK_FINANCIAL_QUESTION':
      case 'UNKNOWN':
        return this.question(userId, req, intent, p, symbols);

      default:
        return reply({ intent: 'UNKNOWN', response: HELP, sections: [{ label: 'INFO', text: HELP }] });
    }
  }

  private async pendingProposal(userId: string, sessionId: string, displayedId?: string): Promise<TradeProposal | null> {
    if (!displayedId) return null;
    try {
      const p = await this.d.trading.getProposal(userId, displayedId);
      return p.sessionId === sessionId && p.status === 'PENDING_APPROVAL' ? p : null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ trade preparation
  private async prepareTrade(userId: string, sessionId: string, p: ParsedParams, symbols: string[]): Promise<AgentReply> {
    if (p.missing?.length || !p.asset || !p.side) {
      const need = p.missing?.includes('asset') ? 'which asset' : 'how much';
      const t = `I need ${need}. Say for example: "buy 20 USDT of BTC".`;
      return reply({ intent: 'PREPARE_TRADE', response: t, requiresClarification: true, sections: [{ label: 'INFO', text: t }] });
    }
    const symbol = await this.symbolFor(userId, p.asset, symbols);
    const proposal = await this.d.trading.prepare(userId, {
      sessionId, symbol, side: p.side, orderType: p.orderType ?? 'MARKET',
      ...(p.quote ? { quoteOrderQty: p.quote } : {}), ...(p.quantity ? { quantity: p.quantity } : {}), ...(p.price ? { price: p.price } : {}),
    });
    const amount = proposal.quoteOrderQty ? `${qty(proposal.quoteOrderQty)} ${proposal.quoteAsset}` : `${qty(proposal.quantity!)} ${proposal.baseAsset}`;
    const text = `Testnet ${proposal.orderType} ${proposal.side} ${symbol}, ${amount}. Review and approve on the glasses.`;
    return reply({
      intent: 'PREPARE_TRADE', response: text,
      sections: [{ label: 'INFO', text }, ...proposal.warnings.map((w) => ({ label: 'INFO' as const, text: w }))],
      evidence: [{ type: 'ticker', reference: `ticker:${symbol}`, value: proposal.referencePrice }],
      uiAction: { type: 'SHOW_PROPOSAL', proposal },
    });
  }

  // ------------------------------------------------------------------ questions (grounded)
  private async question(
    userId: string, req: { sessionId: string; text: string }, intent: Intent, p: ParsedParams, symbols: string[],
  ): Promise<AgentReply> {
    const context = await this.buildContext(userId, req.text, p.asset, symbols);
    if (context.items.length === 0 && this.d.ai.name === 'deterministic') {
      return reply({ intent: 'UNKNOWN', response: `I did not catch that. ${HELP}`, sections: [{ label: 'INFO', text: HELP }] });
    }
    if (this.d.ai.name !== 'deterministic') {
      try {
        const r = await this.d.ai.generateInsight({ question: req.text, asset: p.asset, context });
        // An opinion request can never turn into a trade, whatever the model suggests.
        const safe = p.advice ? { ...r, action: undefined } : r;
        const answer = await this.fromAi(userId, req.sessionId, intent === 'UNKNOWN' ? 'ASK_FINANCIAL_QUESTION' : intent, safe, symbols);
        return p.advice ? { ...answer, sections: [{ label: 'INFO' as const, text: NO_ADVICE }, ...answer.sections] } : answer;
      } catch (err) {
        this.d.log?.warn({ err: err instanceof Error ? err.message : 'unknown' }, 'ai insight failed; using deterministic answer');
      }
    }
    // Deterministic, always-available answer: verified facts, plus an honest statement about causes.
    const facts = context.items.filter((i) => i.type === 'ticker' || i.type === 'stats' || i.type === 'portfolio').slice(0, 3);
    if (facts.length === 0 && p.advice) return reply({ intent: 'ASK_FINANCIAL_QUESTION', response: NO_ADVICE, sections: [{ label: 'INFO', text: NO_ADVICE }] });
    if (facts.length === 0) return reply({ intent: 'UNKNOWN', response: `I did not catch that. ${HELP}`, sections: [{ label: 'INFO', text: HELP }] });
    const cause = 'I cannot verify why it moved: no news or event data source is connected.';
    return reply({
      intent: 'ASK_FINANCIAL_QUESTION', response: `${facts.map((f) => f.text).join(' ')} ${cause}`.slice(0, 400),
      sections: [...(p.advice ? [{ label: 'INFO' as const, text: NO_ADVICE }] : []), ...facts.map((f) => ({ label: 'FACT' as const, text: f.text })), { label: 'UNVERIFIED', text: cause }],
      evidence: facts.map((f) => ({ type: f.type, reference: f.ref, ...(f.value ? { value: f.value } : {}), ...(f.timestamp ? { timestamp: f.timestamp } : {}) })),
      data: { memoriesUsed: context.memories.length },
    });
  }

  private async fromAi(userId: string, sessionId: string, intent: Intent, r: AIResponse, symbols: string[]): Promise<AgentReply> {
    const sections: AgentReply['sections'] = [
      ...r.facts.map((t) => ({ label: 'FACT' as const, text: t })),
      ...(r.interpretation ? [{ label: 'AI' as const, text: r.interpretation }] : []),
      ...(r.unverified ? [{ label: 'UNVERIFIED' as const, text: r.unverified }] : []),
    ];
    const base = reply({
      intent, response: r.response, sections: sections.length ? sections : [{ label: 'AI', text: r.response }], evidence: r.evidence,
      requiresClarification: r.requiresClarification, source: 'ai',
      ...(r.confidence !== undefined ? { data: { confidence: r.confidence } } : {}),
    });
    // A model-suggested trade is only a REQUEST: it goes through the exact same backend validation and approval path.
    if (r.action?.type === 'PREPARE_TRADE') {
      const params = tradeParamsSchema.safeParse(r.action.parameters ?? {});
      if (params.success) {
        const prepared = await this.prepareTrade(userId, sessionId, {
          asset: params.data.asset.toUpperCase(), side: params.data.side, orderType: params.data.price ? 'LIMIT' : 'MARKET',
          ...(params.data.quote ? { quote: params.data.quote } : {}), ...(params.data.quantity ? { quantity: params.data.quantity } : {}),
          ...(params.data.price ? { price: params.data.price } : {}),
        }, symbols).catch((err) => this.errorReply('PREPARE_TRADE', err));
        return { ...prepared, intent: 'PREPARE_TRADE', source: 'ai' };
      }
    }
    return base;
  }

  private async buildContext(userId: string, text: string, asset: string | undefined, symbols: string[]): Promise<AIContext> {
    const items: ContextItem[] = [];
    const [memories, prefs, last] = await Promise.all([this.d.memory.retrieve(userId, text, 5), this.d.memory.preferences(userId), this.d.sessions.lastEnded(userId)]);
    try {
      if (asset) {
        const symbol = await this.symbolFor(userId, asset, symbols);
        const [t, s] = await Promise.all([this.d.market.getTicker(symbol), this.d.market.getStats(symbol)]);
        items.push({ ref: `ticker:${symbol}`, type: 'ticker', text: `${symbol} last price ${price(t.price)} (testnet, ${Math.round(t.ageMs / 1000)}s old).`, value: t.price, timestamp: t.timestamp });
        items.push({ ref: `stats:${symbol}`, type: 'stats', text: `${symbol} 24h change ${pct(s.priceChangePercent)}, high ${price(s.highPrice)}, low ${price(s.lowPrice)}, quote volume ${money(s.quoteVolume, 0)} ${symbol.replace(/^[A-Z0-9]+?(USDT|USDC)$/, '$1')}.`, value: s.priceChangePercent, timestamp: s.timestamp });
      } else if (/\b(portfolio|holdings?|account|balance|how am i doing)\b/i.test(text)) {
        const pf = await this.d.portfolio.getPortfolio();
        items.push({ ref: 'portfolio:testnet', type: 'portfolio', text: `Portfolio about ${money(pf.totalValueUsdt)} USDT over ${pf.coverage.priced} priced assets (testnet)${pf.change24hPercent ? `, 24h ${pct(pf.change24hPercent)}` : ''}.`, value: pf.totalValueUsdt, timestamp: pf.timestamp });
      }
    } catch (err) {
      if (!this.isExchangeIssue(err) && !(err instanceof AppError)) throw err;
    }
    return { items, memories: memories.map((m) => m.content), preferences: prefs, lastSessionSummary: last?.summary ?? undefined };
  }
}
