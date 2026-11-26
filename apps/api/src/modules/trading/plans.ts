import { and, asc, eq, gt, isNull, lte } from 'drizzle-orm';
import { dec, money, price as showPrice, type PlanAlert, type TradePlan } from '@pulse/shared';
import type { Db } from '../../db/client';
import { tradePlans, tradeProposals } from '../../db/schema';
import type { AuditService } from '../../security/audit';
import { AppError } from '../../utils/errors';
import type { MarketService } from '../market/service';
import type { AgentSessionService } from '../sessions/agent-sessions';
import type { TradingService } from './service';

/**
 * Trade plans: "if Bitcoin drops below X, offer to buy Y". Decide when calm, confirm fast.
 * A plan NEVER places an order. The server watches armed plans and records when a level is reached, even while the
 * app is closed. The plan fires once, when the app next checks: if it carries an action AND the condition still
 * holds, an ordinary proposal is prepared that needs the same explicit approval as any trade. If the price has moved
 * back, the wearer is told and nothing is prepared.
 */
type Row = typeof tradePlans.$inferSelect;

export const PLAN_TTL_MS = 24 * 3600_000;
export const MAX_ARMED_PLANS = 5;
export const PLAN_WATCH_MS = 15_000;

export interface PlanInput {
  symbol: string;
  direction: 'ABOVE' | 'BELOW';
  /** Absolute trigger price, or ... */
  price?: string | undefined;
  /** ... a move from the current price, in percent. Exactly one of the two. */
  percent?: string | undefined;
  side?: 'BUY' | 'SELL' | undefined;
  quoteOrderQty?: string | undefined;
  quantity?: string | undefined;
  /** SELL only: share of the free balance (0-1], sized when the plan fires. */
  sellFraction?: string | undefined;
}

/** Pure trigger rule. */
export function isTriggered(direction: 'ABOVE' | 'BELOW', current: string, trigger: string): boolean {
  const c = dec.parse(current);
  const t = dec.parse(trigger);
  return direction === 'ABOVE' ? dec.gte(c, t) : dec.lte(c, t);
}

/** Trigger price from a percentage move, floored to the symbol's tick. */
export function percentTrigger(reference: string, direction: 'ABOVE' | 'BELOW', percent: string, tick: string): string {
  const p = dec.parse(percent);
  if (dec.lt(p, dec.parse('0.01')) || dec.gt(p, dec.parse('50'))) throw new AppError(422, 'INVALID_PERCENT', 'Use a move between 0.01 and 50 percent.');
  const share = dec.div(p, dec.parse('100'));
  const factor = direction === 'ABOVE' ? dec.add(dec.parse('1'), share) : dec.sub(dec.parse('1'), share);
  return dec.fmt(dec.floorToStep(dec.mul(dec.parse(reference), factor), dec.parse(tick)));
}

export class PlanService {
  // The watcher touches the database only while something may be armed (an idle Neon database can sleep).
  private mayBeArmed = true;
  private generation = 0;

  constructor(
    private readonly db: Db,
    private readonly market: MarketService,
    private readonly trading: TradingService,
    private readonly sessions: AgentSessionService,
    private readonly audit: AuditService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  toDto(r: Row): TradePlan {
    const n = (v: string | null) => (v === null ? null : dec.fmt(dec.parse(v)));
    return {
      id: r.id, symbol: r.symbol, direction: r.direction as 'ABOVE' | 'BELOW', triggerPrice: n(r.triggerPrice)!, referencePrice: n(r.referencePrice)!,
      side: (r.side as 'BUY' | 'SELL' | null) ?? null, quoteOrderQty: n(r.quoteOrderQty), quantity: n(r.quantity), status: r.status as TradePlan['status'],
      createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString(),
      triggeredAt: r.triggeredAt?.toISOString() ?? null, observedPrice: n(r.observedPrice),
      sellFraction: n(r.sellFraction), hitAt: r.hitAt?.toISOString() ?? null, hitPrice: n(r.hitPrice),
    };
  }

  /** "BTC below 57,000" */
  static label(p: Pick<TradePlan, 'symbol' | 'direction' | 'triggerPrice'>): string {
    return `${p.symbol.replace(/(USDT|USDC)$/, '')} ${p.direction.toLowerCase()} ${showPrice(p.triggerPrice)}`;
  }

  static actionText(p: Pick<TradePlan, 'side' | 'quoteOrderQty' | 'quantity' | 'sellFraction' | 'symbol'>): string | null {
    if (!p.side) return null;
    const base = p.symbol.replace(/(USDT|USDC)$/, '');
    if (p.sellFraction) return `sell ${PlanService.shareText(p.sellFraction)} ${base}`;
    const amount = p.quoteOrderQty ? `${money(p.quoteOrderQty, 0)} USDT of ${base}` : `${p.quantity} ${base}`;
    return `${p.side.toLowerCase()} ${amount}`;
  }

  /** "half your", "all your", "25% of your". */
  static shareText(fraction: string): string {
    const f = dec.fmt(dec.parse(fraction));
    return f === '0.5' ? 'half your' : f === '1' ? 'all your' : `${dec.fmt(dec.mul(dec.parse(f), dec.parse('100')))}% of your`;
  }

  async create(userId: string, input: PlanInput): Promise<{ plan: TradePlan; alreadyMet: boolean }> {
    const info = await this.market.requireSymbol(input.symbol);
    if ((input.price === undefined) === (input.percent === undefined)) throw new AppError(422, 'INVALID_PLAN', 'Give a price level or a percentage move.');
    const amounts = [input.quoteOrderQty, input.quantity, input.sellFraction].filter((v) => v !== undefined).length;
    if (input.side && amounts !== 1) throw new AppError(422, 'INVALID_PLAN', 'Say how much the plan should offer to trade.');
    if (input.sellFraction !== undefined && (input.side !== 'SELL' || !dec.isDecimalString(input.sellFraction) || dec.gt(dec.parse(input.sellFraction), dec.parse('1')))) {
      throw new AppError(422, 'INVALID_FRACTION', 'Only a sell plan can use a share, between 1 and 100 percent.');
    }
    for (const v of [input.price, input.quoteOrderQty, input.quantity, input.sellFraction]) {
      if (v !== undefined && (!dec.isDecimalString(v) || !dec.gt(dec.parse(v), dec.ZERO))) throw new AppError(422, 'INVALID_AMOUNT', 'Amounts must be greater than zero.');
    }
    const armed = await this.armed(userId);
    if (armed.length >= MAX_ARMED_PLANS) throw new AppError(422, 'TOO_MANY_PLANS', `You already have ${MAX_ARMED_PLANS} plans armed. Cancel one first.`);
    const ticker = await this.market.getTicker(info.symbol, { fresh: true });
    const trigger = input.price !== undefined ? dec.fmt(dec.parse(input.price)) : percentTrigger(ticker.price, input.direction, input.percent!, info.filters.tickSize ?? '0');
    const [row] = await this.db.insert(tradePlans).values({
      userId, symbol: info.symbol, direction: input.direction, triggerPrice: trigger, referencePrice: ticker.price,
      side: input.side ?? null, quoteOrderQty: input.side ? input.quoteOrderQty ?? null : null, quantity: input.side ? input.quantity ?? null : null,
      sellFraction: input.side ? input.sellFraction ?? null : null,
      status: 'ARMED', expiresAt: new Date(this.now().getTime() + PLAN_TTL_MS),
    }).returning();
    this.generation++;
    this.mayBeArmed = true;
    this.audit.fire({ userId, eventType: 'plan.armed', resourceType: 'trade_plan', resourceId: row!.id, metadata: { symbol: info.symbol, direction: input.direction, trigger, side: input.side } });
    return { plan: this.toDto(row!), alreadyMet: isTriggered(input.direction, ticker.price, trigger) };
  }

  private async armed(userId: string): Promise<Row[]> {
    // Lazily close expired plans. One whose level was reached stays until the wearer has been told.
    await this.db.update(tradePlans).set({ status: 'EXPIRED' })
      .where(and(eq(tradePlans.userId, userId), eq(tradePlans.status, 'ARMED'), isNull(tradePlans.hitAt), lte(tradePlans.expiresAt, this.now())));
    return this.db.select().from(tradePlans).where(and(eq(tradePlans.userId, userId), eq(tradePlans.status, 'ARMED'))).orderBy(asc(tradePlans.createdAt));
  }

  async listArmed(userId: string): Promise<TradePlan[]> {
    return (await this.armed(userId)).map((r) => this.toDto(r));
  }

  /** Cancels armed plans: one by id, all for a symbol, or all. Returns what was cancelled. */
  async cancel(userId: string, filter: { id?: string; symbol?: string } = {}): Promise<TradePlan[]> {
    const where = [eq(tradePlans.userId, userId), eq(tradePlans.status, 'ARMED')];
    if (filter.id) where.push(eq(tradePlans.id, filter.id));
    if (filter.symbol) where.push(eq(tradePlans.symbol, filter.symbol));
    const rows = await this.db.update(tradePlans).set({ status: 'CANCELLED' }).where(and(...where)).returning();
    if (filter.id && rows.length === 0) throw new AppError(404, 'PLAN_NOT_FOUND', 'No armed plan with that id.');
    for (const r of rows) this.audit.fire({ userId, eventType: 'plan.cancelled', resourceType: 'trade_plan', resourceId: r.id });
    return rows.map((r) => this.toDto(r));
  }

  /**
   * The server watcher: notes which armed plans have reached their level. It never fires a plan, prepares a proposal
   * or touches an order - that only happens when the wearer's app checks.
   */
  async recordHits(only: { userId?: string } = {}): Promise<number> {
    if (!this.mayBeArmed && !only.userId) return 0;
    const generation = this.generation;
    const where = [eq(tradePlans.status, 'ARMED'), gt(tradePlans.expiresAt, this.now())];
    if (only.userId) where.push(eq(tradePlans.userId, only.userId));
    const rows = await this.db.select().from(tradePlans).where(and(...where));
    if (rows.length === 0 && !only.userId && generation === this.generation) this.mayBeArmed = false;
    const waiting = rows.filter((r) => r.hitAt === null);
    const prices = await this.freshPrices(waiting);
    let hits = 0;
    for (const r of waiting) {
      const current = prices.get(r.symbol);
      if (current === undefined || !isTriggered(r.direction as 'ABOVE' | 'BELOW', current, r.triggerPrice)) continue;
      const [hit] = await this.db.update(tradePlans).set({ hitAt: this.now(), hitPrice: current })
        .where(and(eq(tradePlans.id, r.id), eq(tradePlans.status, 'ARMED'), isNull(tradePlans.hitAt))).returning();
      if (!hit) continue;
      hits++;
      this.audit.fire({ userId: r.userId, eventType: 'plan.level_reached', resourceType: 'trade_plan', resourceId: r.id, metadata: { observed: current } });
    }
    return hits;
  }

  /** Starts the watcher; returns a stop function. Overlapping rounds are skipped. */
  startWatching(onError: (err: unknown) => void, intervalMs = PLAN_WATCH_MS): () => void {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      this.recordHits().catch(onError).finally(() => { running = false; });
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  private async freshPrices(rows: Row[]): Promise<Map<string, string>> {
    const prices = new Map<string, string>();
    for (const symbol of new Set(rows.map((r) => r.symbol))) {
      const t = await this.market.getTicker(symbol, { fresh: true });
      if (t.fresh) prices.set(symbol, t.price);
    }
    return prices;
  }

  /**
   * Evaluates armed plans against fresh prices. Fires at most ONE per call (one thing on the lens at a time),
   * and holds plans with an action while another proposal is awaiting the wearer's decision.
   */
  async check(userId: string, sessionId: string): Promise<{ alerts: PlanAlert[]; armed: number }> {
    await this.sessions.requireActive(userId, sessionId);
    const rows = await this.armed(userId);
    if (rows.length === 0) return { alerts: [], armed: 0 };
    const prices = await this.freshPrices(rows);
    const expired = (r: Row) => r.expiresAt.getTime() <= this.now().getTime();
    const holds = (r: Row) => !expired(r) && isTriggered(r.direction as 'ABOVE' | 'BELOW', prices.get(r.symbol)!, r.triggerPrice);
    // Due: the level is reached now, or the watcher saw it reached earlier. Never without a fresh price.
    const met = rows.filter((r) => prices.has(r.symbol) && (r.hitAt !== null || holds(r)));
    if (met.length === 0) return { alerts: [], armed: rows.length };

    const [pending] = await this.db.select({ id: tradeProposals.id, expiresAt: tradeProposals.expiresAt }).from(tradeProposals)
      .where(and(eq(tradeProposals.sessionId, sessionId), eq(tradeProposals.status, 'PENDING_APPROVAL'))).limit(1);
    const busy = pending !== undefined && pending.expiresAt > this.now();
    const next = met.find((r) => !busy || r.side === null || !holds(r));
    if (!next) return { alerts: [], armed: rows.length };

    const observed = prices.get(next.symbol)!;
    // Compare-and-set: concurrent checks can never fire the same plan twice.
    const [fired] = await this.db.update(tradePlans).set({ status: 'TRIGGERED', triggeredAt: this.now(), observedPrice: observed })
      .where(and(eq(tradePlans.id, next.id), eq(tradePlans.status, 'ARMED'))).returning();
    if (!fired) return { alerts: [], armed: rows.length - 1 };
    const plan = this.toDto(fired);
    this.audit.fire({ userId, sessionId, eventType: 'plan.triggered', resourceType: 'trade_plan', resourceId: plan.id, metadata: { observed } });

    let proposal = null;
    let note: string;
    if (!holds(next)) {
      // Reached while nobody was looking, but not any more: report it, offer nothing.
      note = `Hit ${showPrice(plan.hitPrice!)} earlier${expired(next) ? '. Plan expired.' : ', then moved back.'}${plan.side ? ' No order.' : ''}`;
    } else if (!plan.side) {
      note = 'No order attached.';
    } else {
      try {
        const sized = plan.sellFraction ? (await this.trading.sellQuantity(plan.symbol, plan.sellFraction)).quantity : plan.quantity;
        proposal = await this.trading.prepare(userId, {
          sessionId, symbol: plan.symbol, side: plan.side, orderType: 'MARKET',
          ...(plan.quoteOrderQty ? { quoteOrderQty: plan.quoteOrderQty } : {}), ...(sized ? { quantity: sized } : {}),
        }, { notes: [`PLAN: ${PlanService.label(plan)} reached`] });
        note = 'Your order is ready for approval.';
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        note = `Could not prepare the order: ${err.message}`;
      }
    }
    const message = `Plan fired: ${PlanService.label(plan)}. Now ${showPrice(observed)}. ${note}`;
    return { alerts: [{ plan, proposal, message, note }], armed: rows.length - 1 };
  }
}
