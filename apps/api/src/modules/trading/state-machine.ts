import type { TradeStatus } from '@pulse/shared';
import { AppError } from '../../utils/errors';

/**
 * Backend-enforced proposal lifecycle. The client can never set a status directly; every change
 * goes through a compare-and-set UPDATE guarded by canTransition().
 *
 * Note: the PRD diagram's DRAFT and VALIDATING states happen inside a single prepare() call and are
 * not persisted; a proposal is first stored as PENDING_APPROVAL, after validation succeeds.
 */
export const TRANSITIONS: Readonly<Record<TradeStatus, readonly TradeStatus[]>> = {
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'EXPIRED'],
  APPROVED: ['SUBMITTING', 'EXPIRED', 'FAILED'],
  SUBMITTING: ['SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'FAILED', 'UNKNOWN'],
  SUBMITTED: ['PARTIALLY_FILLED', 'FILLED', 'FAILED'],
  PARTIALLY_FILLED: ['FILLED', 'FAILED'],
  UNKNOWN: ['SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'FAILED'],
  REJECTED: [],
  EXPIRED: [],
  FILLED: [],
  FAILED: [],
};

export const TERMINAL: ReadonlySet<TradeStatus> = new Set(['REJECTED', 'EXPIRED', 'FILLED', 'FAILED']);

export function canTransition(from: TradeStatus, to: TradeStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TradeStatus, to: TradeStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError(409, 'INVALID_STATE', `A proposal in ${from} state cannot move to ${to}.`);
  }
}

/** Maps Binance order status (+ executed quantity) to the proposal lifecycle. Exchange state is the only input. */
export function proposalStatusFromExchange(exchangeStatus: string, executedQty: string): { status: TradeStatus; reason?: string } {
  const executed = executedQty !== '' && !/^0(\.0+)?$/.test(executedQty);
  switch (exchangeStatus) {
    case 'FILLED':
      return { status: 'FILLED' };
    case 'PARTIALLY_FILLED':
      return { status: 'PARTIALLY_FILLED' };
    case 'NEW':
    case 'PENDING_NEW':
      return { status: 'SUBMITTED' };
    case 'CANCELED':
    case 'EXPIRED':
    case 'EXPIRED_IN_MATCH':
      return executed ? { status: 'PARTIALLY_FILLED', reason: `EXCHANGE_${exchangeStatus}` } : { status: 'FAILED', reason: `EXCHANGE_${exchangeStatus}` };
    case 'REJECTED':
      return { status: 'FAILED', reason: 'EXCHANGE_REJECTED' };
    default:
      return { status: 'SUBMITTED' };
  }
}
