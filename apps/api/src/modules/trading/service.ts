import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import {
  dec, type ExchangeOrderDto, type ExecuteResult, type PrepareTradeRequest, type TradeProposal, type TradeStatus,
} from '@pulse/shared';
import type { Env } from '../../config/env';
import type { Db } from '../../db/client';
import { exchangeOrders, idempotencyRecords, tradeApprovals, tradeProposals } from '../../db/schema';
import type { AuditService } from '../../security/audit';
import { AppError } from '../../utils/errors';
import {
  BINANCE_ORDER_NOT_FOUND, ExchangeRejectedError, ExchangeUnavailableError, markValidated,
  type ExchangeAdapter, type ExchangeOrder, type OrderRequest,
} from '../exchange/types';
import type { MarketService } from '../market/service';
import type { PortfolioService } from '../portfolio/service';
import type { AgentSessionService } from '../sessions/agent-sessions';
import { hashesEqual, proposalHash, type MaterialTerms } from './hash';
import { TERMINAL, assertTransition, proposalStatusFromExchange } from './state-machine';
import { checkBalance, normalizeOrder, validateOrder, type OrderTerms } from './validation';

type ProposalRow = typeof tradeProposals.$inferSelect;
type OrderRow = typeof exchangeOrders.$inferSelect;

interface Snapshot {
  referencePrice: string;
  estimatedQuantity?: string;
  estimatedTotal?: string;
  estimatedFee?: string;
  quoteAsset: string;
  baseAsset: string;
  warnings: string[];
}

const ENV = 'TESTNET';
const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
const nn = (v: string | null | undefined): string | undefined => (v === null || v === undefined ? undefined : dec.fmt(dec.parse(v)));

export class TradingService {
  constructor(
    private readonly db: Db,
    private readonly market: MarketService,
    private readonly portfolio: PortfolioService,
    private readonly exchange: ExchangeAdapter,
    private readonly audit: AuditService,
    private readonly sessions: AgentSessionService,
    private readonly env: Pick<Env, 'PROPOSAL_TTL_SECONDS' | 'PRICE_MOVE_TOLERANCE_PERCENT'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ---------------------------------------------------------------- mapping
  toProposalDto(r: ProposalRow): TradeProposal {
    const s = r.proposalSnapshot as Snapshot;
    return {
      id: r.id, userId: r.userId, sessionId: r.sessionId, environment: ENV,
      symbol: r.symbol, side: r.side as 'BUY' | 'SELL', orderType: r.orderType as 'MARKET' | 'LIMIT',
      ...(r.quantity !== null ? { quantity: nn(r.quantity)! } : {}),
      ...(r.quoteOrderQty !== null ? { quoteOrderQty: nn(r.quoteOrderQty)! } : {}),
      ...(r.price !== null ? { price: nn(r.price)! } : {}),
      referencePrice: s.referencePrice,
      ...(s.estimatedQuantity ? { estimatedQuantity: s.estimatedQuantity } : {}),
      ...(s.estimatedTotal ? { estimatedTotal: s.estimatedTotal } : {}),
      ...(s.estimatedFee ? { estimatedFee: s.estimatedFee } : {}),
      quoteAsset: s.quoteAsset, baseAsset: s.baseAsset, warnings: s.warnings,
      status: r.status as TradeStatus, proposalHash: r.proposalHash,
      expiresAt: r.expiresAt.toISOString(), createdAt: r.createdAt.toISOString(),
      ...(r.failureReason ? { failureReason: r.failureReason } : {}),
    };
  }

  toOrderDto(o: OrderRow): ExchangeOrderDto {
    return {
      id: o.id, proposalId: o.proposalId, symbol: o.symbol, side: o.side as 'BUY' | 'SELL', orderType: o.orderType as 'MARKET' | 'LIMIT',
      status: o.status, exchangeOrderId: o.exchangeOrderId, clientOrderId: o.clientOrderId,
      originalQuantity: nn(o.originalQuantity) ?? null, executedQuantity: nn(o.executedQuantity) ?? null,
      quoteQuantity: nn(o.quoteQuantity) ?? null, averagePrice: nn(o.averagePrice) ?? null,
      confirmed: o.exchangeOrderId !== null, environment: ENV, updatedAt: o.updatedAt.toISOString(),
    };
  }

  private materialOf(r: ProposalRow): MaterialTerms {
    return {
      userId: r.userId, sessionId: r.sessionId, symbol: r.symbol, side: r.side, orderType: r.orderType,
      quantity: nn(r.quantity) ?? null, quoteOrderQty: nn(r.quoteOrderQty) ?? null, price: nn(r.price) ?? null,
      environment: r.environment, expiresAt: r.expiresAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------- loading
  private async load(userId: string, id: string): Promise<ProposalRow> {
    const [r] = await this.db.select().from(tradeProposals).where(and(eq(tradeProposals.id, id), eq(tradeProposals.userId, userId))).limit(1);
    if (!r) throw new AppError(404, 'PROPOSAL_NOT_FOUND', 'Trade proposal not found.');
    return r;
  }

  /** Compare-and-set status change. Returns the updated row, or null if the row was not in an expected state. */
  private async transition(
    id: string, from: TradeStatus[], to: TradeStatus, extra: Partial<typeof tradeProposals.$inferInsert> = {},
  ): Promise<ProposalRow | null> {
    for (const f of from) assertTransition(f, to);
    const [row] = await this.db
      .update(tradeProposals).set({ ...extra, status: to, updatedAt: this.now() })
      .where(and(eq(tradeProposals.id, id), inArray(tradeProposals.status, from))).returning();
    return row ?? null;
  }

  private async expireIfNeeded(r: ProposalRow): Promise<ProposalRow> {
    if ((r.status === 'PENDING_APPROVAL' || r.status === 'APPROVED') && r.expiresAt.getTime() <= this.now().getTime()) {
      const updated = await this.transition(r.id, [r.status as TradeStatus], 'EXPIRED', { failureReason: 'EXPIRED' });
      this.audit.fire({ userId: r.userId, sessionId: r.sessionId, eventType: 'trade.proposal_expired', resourceType: 'trade_proposal', resourceId: r.id });
      return updated ?? (await this.load(r.userId, r.id));
    }
    return r;
  }

  async getProposal(userId: string, id: string): Promise<TradeProposal> {
    let r = await this.expireIfNeeded(await this.load(userId, id));
    if (r.status === 'UNKNOWN') r = await this.reconcile(r);
    return this.toProposalDto(r);
  }

  // ---------------------------------------------------------------- prepare
  /** `notes` are server-side context lines (plan fired, smart default) shown first on the approval screen. */
  async prepare(userId: string, req: PrepareTradeRequest, extra: { notes?: string[] } = {}): Promise<TradeProposal> {
    // Independent reads run together: Neon + exchange latency dominates, so sequential awaits are expensive.
    const [, info, ticker, account] = await Promise.all([
      this.sessions.requireActive(userId, req.sessionId),
      this.market.requireSymbol(req.symbol),
      this.market.getTicker(req.symbol.trim().toUpperCase(), { fresh: true }),
      this.portfolio.getAccount(true),
    ]);
    if (!ticker.fresh) throw new AppError(503, 'STALE_QUOTE', 'The latest price is stale. Try again in a moment.');
    const free = (asset: string) => account.balances.find((b) => b.asset === asset)?.free ?? '0';

    const { terms, warnings } = normalizeOrder(
      info, { side: req.side, orderType: req.orderType, quantity: req.quantity, quoteOrderQty: req.quoteOrderQty, price: req.price }, ticker.price,
    );
    validateOrder(info, terms, ticker.price);
    checkBalance(info, terms, ticker.price, free);

    const px = dec.parse(terms.price ?? ticker.price);
    const taker = dec.parse(account.takerFee);
    let estQty: string | undefined;
    let estTotal: bigint;
    if (terms.quoteOrderQty !== undefined) {
      estTotal = dec.parse(terms.quoteOrderQty);
      const step = dec.parse(info.filters.marketStepSize && info.filters.marketStepSize !== '0' ? info.filters.marketStepSize : info.filters.stepSize ?? '0');
      estQty = dec.fmt(dec.floorToStep(dec.div(estTotal, px), step));
    } else {
      estTotal = dec.mul(dec.parse(terms.quantity!), px);
    }
    const snapshot: Snapshot = {
      referencePrice: dec.fmt(dec.parse(ticker.price)),
      ...(estQty ? { estimatedQuantity: estQty } : {}),
      estimatedTotal: dec.fmtFixed(estTotal, 2),
      estimatedFee: dec.fmtFixed(dec.mul(estTotal, taker), 4),
      quoteAsset: info.quoteAsset, baseAsset: info.baseAsset, warnings: [...(extra.notes ?? []), ...warnings],
    };

    // Only one live proposal per session: a new one supersedes any still-pending one.
    // (one CAS UPDATE that excludes the new row, run in parallel with its INSERT)
    assertTransition('PENDING_APPROVAL', 'EXPIRED');
    const newId = randomUUID();
    const supersede = this.db.update(tradeProposals).set({ status: 'EXPIRED', failureReason: 'SUPERSEDED', updatedAt: this.now() })
      .where(and(eq(tradeProposals.sessionId, req.sessionId), eq(tradeProposals.status, 'PENDING_APPROVAL'), ne(tradeProposals.id, newId)));

    const expiresAt = new Date(this.now().getTime() + this.env.PROPOSAL_TTL_SECONDS * 1000);
    const material: MaterialTerms = {
      userId, sessionId: req.sessionId, symbol: info.symbol, side: terms.side, orderType: terms.orderType,
      quantity: terms.quantity ?? null, quoteOrderQty: terms.quoteOrderQty ?? null, price: terms.price ?? null,
      environment: ENV, expiresAt: expiresAt.toISOString(),
    };
    const [[row]] = await Promise.all([
      this.db.insert(tradeProposals).values({
        id: newId, userId, sessionId: req.sessionId, symbol: info.symbol, side: terms.side, orderType: terms.orderType,
        quantity: terms.quantity ?? null, quoteOrderQty: terms.quoteOrderQty ?? null, price: terms.price ?? null,
        environment: ENV, status: 'PENDING_APPROVAL', proposalSnapshot: snapshot, proposalHash: proposalHash(material), expiresAt,
      }).returning(),
      supersede,
    ]);
    this.audit.fire({
      userId, sessionId: req.sessionId, eventType: 'trade.proposal_created', resourceType: 'trade_proposal', resourceId: row!.id,
      metadata: { symbol: info.symbol, side: terms.side, orderType: terms.orderType, quantity: terms.quantity, quoteOrderQty: terms.quoteOrderQty, price: terms.price },
    });
    return this.toProposalDto(row!);
  }

  // ---------------------------------------------------------------- approve / reject
  async approve(userId: string, id: string, body: { sessionId: string; proposalHash: string; method: 'glasses_gesture' | 'voice' }): Promise<TradeProposal> {
    // The session check runs alongside the load (one round trip); its error, if any, is raised after the mismatch check.
    const [loaded, sessionError] = await Promise.all([this.load(userId, id), this.sessions.requireActive(userId, body.sessionId).then(() => null, (e: unknown) => e)]);
    let r = await this.expireIfNeeded(loaded);
    if (r.sessionId !== body.sessionId) {
      await this.audit.record({ userId, sessionId: body.sessionId, eventType: 'security.approval_session_mismatch', resourceType: 'trade_proposal', resourceId: id });
      throw new AppError(403, 'SESSION_MISMATCH', 'This proposal belongs to a different session.');
    }
    if (sessionError) throw sessionError;
    if (r.environment !== ENV) throw new AppError(403, 'WRONG_ENVIRONMENT', 'Only testnet proposals can be approved.');
    if (r.status === 'EXPIRED') throw new AppError(409, 'PROPOSAL_EXPIRED', 'This proposal expired. Ask PULSE to prepare it again.');
    if (r.status !== 'PENDING_APPROVAL') throw new AppError(409, 'INVALID_STATE', `This proposal is ${r.status.toLowerCase().replace(/_/g, ' ')} and cannot be approved.`);

    const stored = proposalHash(this.materialOf(r));
    if (!hashesEqual(stored, r.proposalHash) || !hashesEqual(body.proposalHash, r.proposalHash)) {
      await this.audit.record({ userId, sessionId: r.sessionId, eventType: 'security.approval_hash_mismatch', resourceType: 'trade_proposal', resourceId: id });
      throw new AppError(409, 'PROPOSAL_CHANGED', 'The proposal changed since it was shown. Review the new terms.');
    }

    const now = this.now();
    const [updated] = await this.db.update(tradeProposals).set({ status: 'APPROVED', approvedAt: now, updatedAt: now })
      .where(and(eq(tradeProposals.id, id), eq(tradeProposals.status, 'PENDING_APPROVAL'))).returning();
    if (!updated) throw new AppError(409, 'INVALID_STATE', 'This proposal is no longer awaiting approval.');
    r = updated;

    await this.db.insert(tradeApprovals).values({
      proposalId: id, userId, sessionId: r.sessionId, approvalMethod: body.method, approvedAt: now,
      approvedSnapshot: { ...this.materialOf(r), proposalHash: r.proposalHash, snapshot: r.proposalSnapshot as Snapshot },
    });
    this.audit.fire({
      userId, sessionId: r.sessionId, eventType: 'trade.approved', resourceType: 'trade_proposal', resourceId: id,
      metadata: { method: body.method, symbol: r.symbol, side: r.side },
    });
    return this.toProposalDto(r);
  }

  async reject(userId: string, id: string, sessionId?: string): Promise<TradeProposal> {
    const r = await this.expireIfNeeded(await this.load(userId, id));
    if (sessionId && r.sessionId !== sessionId) throw new AppError(403, 'SESSION_MISMATCH', 'This proposal belongs to a different session.');
    if (r.status !== 'PENDING_APPROVAL') throw new AppError(409, 'INVALID_STATE', `This proposal is ${r.status.toLowerCase().replace(/_/g, ' ')} and cannot be rejected.`);
    const updated = await this.transition(id, ['PENDING_APPROVAL'], 'REJECTED', { failureReason: 'USER_REJECTED' });
    if (!updated) throw new AppError(409, 'INVALID_STATE', 'This proposal is no longer awaiting approval.');
    this.audit.fire({ userId, sessionId: r.sessionId, eventType: 'trade.rejected', resourceType: 'trade_proposal', resourceId: id });
    return this.toProposalDto(updated);
  }

  // ---------------------------------------------------------------- execute
  async execute(userId: string, id: string, idempotencyKey: string): Promise<{ result: ExecuteResult; replay: boolean }> {
    if (!/^[A-Za-z0-9_\-:.]{8,128}$/.test(idempotencyKey)) {
      throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'A valid Idempotency-Key header (8-128 chars) is required.');
    }
    const requestHash = createHash('sha256').update(`execute:${id}`).digest('hex');
    const OP = 'trade.execute';

    // 1) Replay / in-flight detection.
    // The three independent reads share one round trip; a load error is held back so a replay still wins.
    const [[prior], loadedOrError, [approval]] = await Promise.all([
      this.db.select().from(idempotencyRecords)
        .where(and(eq(idempotencyRecords.userId, userId), eq(idempotencyRecords.idempotencyKey, idempotencyKey), eq(idempotencyRecords.operation, OP))).limit(1),
      this.load(userId, id).then((v) => v, (e: unknown) => e),
      this.db.select().from(tradeApprovals).where(eq(tradeApprovals.proposalId, id)).limit(1),
    ]);
    if (prior) return this.handlePriorIdempotency(prior, requestHash);

    // 2) Preconditions (nothing is reserved yet, so a failure here never poisons the key).
    if (!('id' in (loadedOrError as object)) || loadedOrError instanceof Error) throw loadedOrError;
    let r = await this.expireIfNeeded(loadedOrError as ProposalRow);
    if (r.environment !== ENV) throw new AppError(403, 'WRONG_ENVIRONMENT', 'Only testnet proposals can be executed.');
    if (r.status === 'EXPIRED') throw new AppError(409, 'PROPOSAL_EXPIRED', 'This proposal expired. Ask PULSE to prepare it again.');
    if (r.status !== 'APPROVED') {
      const code = r.status === 'PENDING_APPROVAL' ? 'APPROVAL_REQUIRED' : 'INVALID_STATE';
      throw new AppError(409, code, r.status === 'PENDING_APPROVAL' ? 'This trade has not been approved.' : `This proposal is ${r.status.toLowerCase().replace(/_/g, ' ')} and cannot be executed.`);
    }
    const approvedHash = (approval?.approvedSnapshot as { proposalHash?: string } | undefined)?.proposalHash;
    if (!approval || approval.userId !== userId || !approvedHash || !hashesEqual(approvedHash, r.proposalHash) || !hashesEqual(proposalHash(this.materialOf(r)), r.proposalHash)) {
      await this.audit.record({ userId, sessionId: r.sessionId, eventType: 'security.execute_without_valid_approval', resourceType: 'trade_proposal', resourceId: id });
      throw new AppError(409, 'APPROVAL_INVALID', 'No valid approval matches this proposal.');
    }

    // 3) Reserve the idempotency key (unique index makes concurrent duplicates lose here).
    const reserved = await this.db.insert(idempotencyRecords).values({
      userId, idempotencyKey, operation: OP, requestHash, status: 'IN_PROGRESS', expiresAt: new Date(this.now().getTime() + IDEMPOTENCY_TTL_MS),
    }).onConflictDoNothing().returning({ id: idempotencyRecords.id });
    if (reserved.length === 0) {
      const [again] = await this.db.select().from(idempotencyRecords)
        .where(and(eq(idempotencyRecords.userId, userId), eq(idempotencyRecords.idempotencyKey, idempotencyKey), eq(idempotencyRecords.operation, OP))).limit(1);
      return this.handlePriorIdempotency(again!, requestHash);
    }
    const releaseKey = () => this.db.delete(idempotencyRecords).where(eq(idempotencyRecords.id, reserved[0]!.id));

    // 4) Revalidate against the live exchange (filters, balance, price drift).
    const terms: OrderTerms = {
      side: r.side as 'BUY' | 'SELL', orderType: r.orderType as 'MARKET' | 'LIMIT',
      quantity: nn(r.quantity), quoteOrderQty: nn(r.quoteOrderQty), price: nn(r.price),
    };
    let ticker;
    try {
      const [, info, tk, account] = await Promise.all([
        this.sessions.requireActive(userId, r.sessionId), this.market.requireSymbol(r.symbol), this.market.getTicker(r.symbol, { fresh: true }), this.portfolio.getAccount(true),
      ]);
      ticker = tk;
      if (!ticker.fresh) throw new AppError(503, 'STALE_QUOTE', 'The latest price is stale. Try again in a moment.');
      validateOrder(info, terms, ticker.price);
      checkBalance(info, terms, ticker.price, (a) => account.balances.find((b) => b.asset === a)?.free ?? '0');
    } catch (err) {
      await releaseKey();
      if (err instanceof AppError && ['INSUFFICIENT_BALANCE', 'BELOW_MIN_NOTIONAL', 'BELOW_MIN_QTY', 'INVALID_PRECISION', 'SYMBOL_NOT_TRADING'].includes(err.code)) {
        await this.transition(id, ['APPROVED'], 'FAILED', { failureReason: err.code });
        this.audit.fire({ userId, sessionId: r.sessionId, eventType: 'trade.revalidation_failed', resourceType: 'trade_proposal', resourceId: id, metadata: { code: err.code } });
      }
      throw err;
    }

    if (terms.orderType === 'MARKET') {
      const ref = dec.parse((r.proposalSnapshot as Snapshot).referencePrice);
      const move = dec.abs(dec.pctChange(ref, dec.parse(ticker.price)));
      if (dec.gt(move, dec.parse(String(this.env.PRICE_MOVE_TOLERANCE_PERCENT)))) {
        await releaseKey();
        await this.transition(id, ['APPROVED'], 'EXPIRED', { failureReason: 'PRICE_MOVED' });
        this.audit.fire({ userId, sessionId: r.sessionId, eventType: 'trade.requote_required', resourceType: 'trade_proposal', resourceId: id, metadata: { movePercent: dec.fmtFixed(move, 2) } });
        const fresh = await this.prepare(userId, {
          sessionId: r.sessionId, symbol: r.symbol, side: terms.side, orderType: terms.orderType,
          ...(terms.quantity ? { quantity: terms.quantity } : {}), ...(terms.quoteOrderQty ? { quoteOrderQty: terms.quoteOrderQty } : {}),
        });
        throw new AppError(409, 'REQUOTE_REQUIRED', 'The price moved since you approved. Review the new quote and approve again.', { proposal: fresh });
      }
    }

    // 5) APPROVED -> SUBMITTING (CAS) and record the attempt BEFORE talking to the exchange.
    const submitting = await this.transition(id, ['APPROVED'], 'SUBMITTING', { submittedAt: this.now() });
    if (!submitting) {
      await releaseKey();
      throw new AppError(409, 'INVALID_STATE', 'This proposal is no longer approved.');
    }
    r = submitting;
    const clientOrderId = `p${r.id.replace(/-/g, '')}`; // 33 chars, deterministic per proposal, <= 36
    let orderRow: OrderRow;
    try {
      [orderRow] = (await this.db.insert(exchangeOrders).values({
        userId, proposalId: r.id, exchange: 'binance-spot-testnet', environment: ENV, symbol: r.symbol, clientOrderId,
        side: r.side, orderType: r.orderType, status: 'PENDING_SUBMIT',
        originalQuantity: r.quantity, quoteQuantity: null,
      }).returning()) as [OrderRow];
    } catch {
      // Unique(proposal_id): an order row already exists - never submit twice.
      await this.transition(id, ['SUBMITTING'], 'UNKNOWN', { failureReason: 'DUPLICATE_ATTEMPT' });
      throw new AppError(409, 'ALREADY_SUBMITTED', 'This proposal already has an order attempt.');
    }
    this.audit.fire({ userId, sessionId: r.sessionId, eventType: 'trade.submission_attempt', resourceType: 'exchange_order', resourceId: orderRow.id, metadata: { clientOrderId, symbol: r.symbol } });

    // 6) The one and only write to the exchange.
    const request: OrderRequest = {
      symbol: r.symbol, side: terms.side, type: terms.orderType, newClientOrderId: clientOrderId,
      ...(terms.quantity ? { quantity: terms.quantity } : {}),
      ...(terms.quoteOrderQty ? { quoteOrderQty: terms.quoteOrderQty } : {}),
      ...(terms.price ? { price: terms.price } : {}),
    };
    let message: string;
    try {
      const placed = await this.exchange.createOrder(markValidated(request));
      ({ proposal: r, order: orderRow } = await this.applyExchangeOrder(r, orderRow, placed));
      message = this.describe(r, orderRow);
    } catch (err) {
      if (err instanceof ExchangeRejectedError) {
        // Definitive 4xx: the exchange did not accept the order.
        r = (await this.transition(id, ['SUBMITTING'], 'FAILED', { failureReason: `EXCHANGE_${err.code ?? err.status}` })) ?? r;
        const [rejected] = await this.db.update(exchangeOrders).set({ status: 'REJECTED', updatedAt: this.now(), exchangeResponse: { code: err.code ?? null, msg: err.exchangeMessage } })
          .where(eq(exchangeOrders.id, orderRow.id)).returning();
        orderRow = rejected!;
        message = `Not placed: ${err.exchangeMessage}`;
      } else {
        // Timeout / network / 5xx / anything unexpected: the order MAY exist. Never resubmit; reconcile.
        r = (await this.transition(id, ['SUBMITTING'], 'UNKNOWN', { failureReason: 'SUBMISSION_UNCERTAIN' })) ?? r;
        this.audit.fire({ userId, sessionId: r.sessionId, eventType: 'trade.submission_uncertain', resourceType: 'exchange_order', resourceId: orderRow.id });
        r = await this.reconcile(r);
        const [o] = await this.db.select().from(exchangeOrders).where(eq(exchangeOrders.id, orderRow.id)).limit(1);
        orderRow = o!;
        message = this.describe(r, orderRow);
      }
    }

    const result: ExecuteResult = { proposal: this.toProposalDto(r), order: this.toOrderDto(orderRow), message };
    await this.db.update(idempotencyRecords).set({ status: 'COMPLETED', responseSnapshot: result })
      .where(eq(idempotencyRecords.id, reserved[0]!.id));
    this.audit.fire({ userId, sessionId: r.sessionId, eventType: 'trade.executed', resourceType: 'exchange_order', resourceId: orderRow.id, metadata: { status: r.status, exchangeStatus: orderRow.status } });
    return { result, replay: false };
  }

  private handlePriorIdempotency(prior: typeof idempotencyRecords.$inferSelect, requestHash: string): { result: ExecuteResult; replay: boolean } {
    if (prior.requestHash !== requestHash) {
      throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used for a different request.');
    }
    if (prior.status === 'COMPLETED' && prior.responseSnapshot) {
      return { result: prior.responseSnapshot as ExecuteResult, replay: true };
    }
    throw new AppError(409, 'REQUEST_IN_PROGRESS', 'This request is already being processed.');
  }

  // ---------------------------------------------------------------- reconcile / status
  /** Applies an exchange order snapshot to the order row and proposal. Exchange data is the only input. */
  private async applyExchangeOrder(r: ProposalRow, o: OrderRow, ex: ExchangeOrder): Promise<{ proposal: ProposalRow; order: OrderRow }> {
    const mapped = proposalStatusFromExchange(ex.status, ex.executedQty);
    // Two independent rows: update them in one round trip.
    const [[order], moved] = await Promise.all([
      this.db.update(exchangeOrders).set({
        exchangeOrderId: ex.orderId, status: ex.status, originalQuantity: ex.origQty, executedQuantity: ex.executedQty,
        quoteQuantity: ex.cummulativeQuoteQty, averagePrice: ex.averagePrice, exchangeResponse: ex as unknown as Record<string, unknown>, updatedAt: this.now(),
      }).where(eq(exchangeOrders.id, o.id)).returning(),
      mapped.status !== r.status
        ? this.transition(r.id, [r.status as TradeStatus], mapped.status, mapped.reason ? { failureReason: mapped.reason } : {})
        : Promise.resolve(null),
    ]);
    return { proposal: moved ?? r, order: order! };
  }

  /** Looks the order up on the exchange by client order id. Retries nothing; resubmits nothing. */
  private async reconcile(r: ProposalRow): Promise<ProposalRow> {
    const [o] = await this.db.select().from(exchangeOrders).where(eq(exchangeOrders.proposalId, r.id)).limit(1);
    if (!o) return r;
    try {
      const ex = await this.exchange.getOrder(r.symbol, { clientOrderId: o.clientOrderId });
      const applied = await this.applyExchangeOrder(r, o, ex);
      this.audit.fire({ userId: r.userId, sessionId: r.sessionId, eventType: 'trade.reconciled', resourceType: 'exchange_order', resourceId: o.id, metadata: { exchangeStatus: ex.status } });
      return applied.proposal;
    } catch (err) {
      if (err instanceof ExchangeRejectedError && err.code === BINANCE_ORDER_NOT_FOUND) {
        // Binance has no such order, so the earlier submission was NOT accepted. Safe to close; a retry needs a fresh proposal + approval.
        const failed = await this.transition(r.id, [r.status as TradeStatus], 'FAILED', { failureReason: 'NOT_ACCEPTED_BY_EXCHANGE' });
        await this.db.update(exchangeOrders).set({ status: 'REJECTED', updatedAt: this.now() }).where(eq(exchangeOrders.id, o.id));
        this.audit.fire({ userId: r.userId, sessionId: r.sessionId, eventType: 'trade.reconciled_not_accepted', resourceType: 'exchange_order', resourceId: o.id });
        return failed ?? r;
      }
      if (err instanceof ExchangeUnavailableError || err instanceof ExchangeRejectedError) return r; // stay UNKNOWN; verified later
      throw err;
    }
  }

  /** Human-safe line built only from persisted exchange facts. Never says "success" without confirmation. */
  describe(r: ProposalRow, o: OrderRow): string {
    if (o.exchangeOrderId === null) {
      if (r.status === 'FAILED') return `Not placed: ${(r.failureReason ?? 'rejected by exchange').toLowerCase().replace(/_/g, ' ')}.`;
      return 'Order status is being verified.';
    }
    const base = (r.proposalSnapshot as Snapshot).baseAsset;
    const verb = o.side === 'BUY' ? 'Bought' : 'Sold';
    switch (r.status) {
      case 'FILLED':
        return `${verb} ${nn(o.executedQuantity)} ${base}${o.averagePrice ? ` at avg ${nn(o.averagePrice)}` : ''}. Confirmed by Binance testnet.`;
      case 'PARTIALLY_FILLED':
        return `Partially filled: ${nn(o.executedQuantity)} of ${nn(o.originalQuantity)} ${base}.`;
      case 'SUBMITTED':
        return 'Order accepted by Binance testnet and open (not filled yet).';
      case 'FAILED':
        return `Not filled: ${(r.failureReason ?? 'failed').toLowerCase().replace(/_/g, ' ')}.`;
      default:
        return 'Order status is being verified.';
    }
  }

  async listOrders(userId: string, limit = 20): Promise<ExchangeOrderDto[]> {
    const rows = await this.db.select().from(exchangeOrders).where(eq(exchangeOrders.userId, userId)).orderBy(desc(exchangeOrders.createdAt)).limit(limit);
    return rows.map((o) => this.toOrderDto(o));
  }

  async getOrder(userId: string, orderId: string): Promise<ExchangeOrderDto & { message: string }> {
    let o = await this.loadOrder(userId, orderId);
    const open = ['NEW', 'PARTIALLY_FILLED', 'PENDING_SUBMIT'].includes(o.status);
    if (open || o.exchangeOrderId === null) {
      const [p] = await this.db.select().from(tradeProposals).where(eq(tradeProposals.id, o.proposalId)).limit(1);
      if (p && !TERMINAL.has(p.status as TradeStatus)) {
        const r = p.status === 'UNKNOWN' ? await this.reconcile(p) : await this.refreshFromExchange(p, o);
        [o] = await this.db.select().from(exchangeOrders).where(eq(exchangeOrders.id, o.id)).limit(1) as [OrderRow];
        return { ...this.toOrderDto(o), message: this.describe(r, o) };
      }
    }
    const [p] = await this.db.select().from(tradeProposals).where(eq(tradeProposals.id, o.proposalId)).limit(1);
    return { ...this.toOrderDto(o), message: p ? this.describe(p, o) : '' };
  }

  private async refreshFromExchange(p: ProposalRow, o: OrderRow): Promise<ProposalRow> {
    try {
      const ex = await this.exchange.getOrder(p.symbol, { clientOrderId: o.clientOrderId });
      return (await this.applyExchangeOrder(p, o, ex)).proposal;
    } catch (err) {
      if (err instanceof ExchangeUnavailableError || err instanceof ExchangeRejectedError) return p;
      throw err;
    }
  }

  private async loadOrder(userId: string, id: string): Promise<OrderRow> {
    const [o] = await this.db.select().from(exchangeOrders).where(and(eq(exchangeOrders.id, id), eq(exchangeOrders.userId, userId))).limit(1);
    if (!o) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    return o;
  }

  // ---------------------------------------------------------------- open orders
  /** This user's orders that Binance still reports as open, newest first. Statuses are refreshed from the exchange. */
  async openOrders(userId: string): Promise<Array<ExchangeOrderDto & { price: string | null }>> {
    const rows = await this.db.select({ o: exchangeOrders, p: tradeProposals }).from(exchangeOrders)
      .innerJoin(tradeProposals, eq(tradeProposals.id, exchangeOrders.proposalId))
      .where(and(eq(exchangeOrders.userId, userId), inArray(exchangeOrders.status, ['NEW', 'PARTIALLY_FILLED'])))
      .orderBy(desc(exchangeOrders.createdAt)).limit(10);
    const live = await Promise.all(rows.map(async ({ o, p }) => {
      const ex = await this.exchange.getOrder(o.symbol, { clientOrderId: o.clientOrderId });
      const { order } = await this.applyExchangeOrder(p, o, ex);
      return { ...this.toOrderDto(order), price: nn(p.price) ?? null };
    }));
    return live.filter((o) => o.status === 'NEW' || o.status === 'PARTIALLY_FILLED');
  }

  /** Turns "sell half" into an exact quantity of the free balance, rounded down to the lot step. */
  async sellQuantity(symbol: string, fraction: string, orderType: 'MARKET' | 'LIMIT' = 'MARKET'): Promise<{ quantity: string; free: string; base: string }> {
    const share = dec.parse(fraction);
    if (!dec.gt(share, dec.ZERO) || dec.gt(share, dec.parse('1'))) throw new AppError(422, 'INVALID_FRACTION', 'Sell between 1 and 100 percent.');
    const [info, account] = await Promise.all([this.market.requireSymbol(symbol), this.portfolio.getAccount(true)]);
    const free = account.balances.find((b) => b.asset === info.baseAsset)?.free ?? '0';
    const marketStep = info.filters.marketStepSize;
    const step = orderType === 'MARKET' && marketStep && marketStep !== '0' ? marketStep : info.filters.stepSize ?? '0';
    const quantity = dec.floorToStep(dec.mul(dec.parse(free), share), dec.parse(step));
    if (!dec.gt(quantity, dec.ZERO)) throw new AppError(422, 'NOTHING_TO_SELL', `You have no ${info.baseAsset} free to sell.`);
    return { quantity: dec.fmt(quantity), free: dec.fmt(dec.parse(free)), base: info.baseAsset };
  }

  // ---------------------------------------------------------------- cancel
  /** Explicit, id-addressed cancellation of one open order. Never infers which order to cancel. */
  async cancelOrder(userId: string, orderId: string): Promise<ExchangeOrderDto & { message: string }> {
    const o = await this.loadOrder(userId, orderId);
    if (o.exchangeOrderId === null) throw new AppError(409, 'ORDER_NOT_OPEN', 'This order is not confirmed by the exchange, so it cannot be cancelled.');
    const live = await this.exchange.getOrder(o.symbol, { orderId: o.exchangeOrderId });
    if (!['NEW', 'PARTIALLY_FILLED'].includes(live.status)) {
      throw new AppError(409, 'ORDER_NOT_OPEN', `This order is ${live.status.toLowerCase().replace(/_/g, ' ')} and cannot be cancelled.`);
    }
    const cancelled = await this.exchange.cancelOrder(o.symbol, { orderId: o.exchangeOrderId });
    const [p] = await this.db.select().from(tradeProposals).where(eq(tradeProposals.id, o.proposalId)).limit(1);
    const applied = await this.applyExchangeOrder(p!, o, cancelled);
    this.audit.fire({ userId, sessionId: p?.sessionId, eventType: 'trade.cancelled', resourceType: 'exchange_order', resourceId: o.id, metadata: { exchangeOrderId: o.exchangeOrderId } });
    return { ...this.toOrderDto(applied.order), message: `Order cancelled on Binance testnet (${applied.order.status.toLowerCase()}).` };
  }

  async latestOrderForSession(userId: string, sessionId: string) {
    const [p] = await this.db.select().from(tradeProposals)
      .where(and(eq(tradeProposals.userId, userId), eq(tradeProposals.sessionId, sessionId))).orderBy(desc(tradeProposals.createdAt)).limit(1);
    return p ? this.toProposalDto(p) : null;
  }

  /** Quote amount of the user's most recent filled market buy (a "smart default" for the next one). */
  async lastFilledBuyAmount(userId: string): Promise<string | null> {
    const [p] = await this.db.select({ amount: tradeProposals.quoteOrderQty }).from(tradeProposals)
      .where(and(eq(tradeProposals.userId, userId), eq(tradeProposals.status, 'FILLED'), eq(tradeProposals.side, 'BUY'), isNotNull(tradeProposals.quoteOrderQty)))
      .orderBy(desc(tradeProposals.createdAt)).limit(1);
    return p?.amount ? dec.fmt(dec.parse(p.amount)) : null;
  }

  async lastOrder(userId: string) {
    const [o] = await this.db.select().from(exchangeOrders).where(eq(exchangeOrders.userId, userId)).orderBy(desc(exchangeOrders.createdAt)).limit(1);
    return o ? this.getOrder(userId, o.id) : null;
  }
}
