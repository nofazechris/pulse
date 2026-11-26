import type { AgentReply, ExchangeOrderDto, ExecuteResult, MarketStats, PlanAlert, Portfolio, TradeProposal, Watchlist } from '@pulse/shared';

export type ScreenId = 'connection' | 'home' | 'portfolio' | 'market' | 'watchlist' | 'insight' | 'proposal' | 'cancel' | 'result' | 'alert' | 'try' | 'error';
export type VoiceState = 'IDLE' | 'LISTENING' | 'PROCESSING' | 'RESPONDING' | 'AWAITING_APPROVAL' | 'ERROR';
export type ConnectionStatus = 'initializing' | 'connected' | 'reconnecting' | 'offline' | 'auth_required' | 'exchange_unavailable';
export type AuthStatus = 'unauthenticated' | 'pairing' | 'authenticated';

/** One open order on the lens, waiting for the wearer to confirm cancelling it. */
export interface PendingCancel {
  order: ExchangeOrderDto;
  price: string | null;
  openCount: number;
  /** Set once Binance confirms the cancellation. */
  done: boolean;
}

export interface PulseState {
  connectionStatus: ConnectionStatus;
  authenticationStatus: AuthStatus;
  currentScreen: ScreenId;
  voiceState: VoiceState;
  mode: 'LIVE' | 'DEMO';
  /** True once the wearer has chosen the no-server practice mode. */
  practice: boolean;
  /** Whether practice mode can be offered. */
  canPractice: boolean;
  backend: 'unknown' | 'ok' | 'down';
  exchange: 'unknown' | 'ok' | 'down';

  portfolio: Portfolio | null;
  watchlist: Watchlist | null;
  market: MarketStats | null;
  marketSymbol: string | null;

  activeSessionId: string | null;
  activeProposal: TradeProposal | null;
  approvalChoice: 'REJECT' | 'APPROVE';
  lastReply: AgentReply | null;
  lastResult: ExecuteResult | null;
  /** Trade plans still waiting for their price (the server watches them even while the app is closed). */
  armedPlans: number;
  /** The plan that just fired, if any. */
  activeAlert: PlanAlert | null;

  pendingCancel: PendingCancel | null;
  cancelChoice: 'KEEP' | 'CANCEL';

  listIndex: number;
  scroll: number;
  notice: string | null;
  /** An approved order failed before confirmation: tapping the error screen retries the SAME order. */
  retryOrder: boolean;
  lastError: string | null;
  lastTranscript: string | null;
  now: number;
}

export const initialState: PulseState = {
  connectionStatus: 'initializing', authenticationStatus: 'unauthenticated', currentScreen: 'connection', voiceState: 'IDLE',
  mode: 'LIVE', practice: false, canPractice: false, backend: 'unknown', exchange: 'unknown',
  portfolio: null, watchlist: null, market: null, marketSymbol: null,
  activeSessionId: null, activeProposal: null, approvalChoice: 'REJECT', lastReply: null, lastResult: null, armedPlans: 0, activeAlert: null, pendingCancel: null, cancelChoice: 'KEEP',
  listIndex: 0, scroll: 0, notice: null, retryOrder: false, lastError: null, lastTranscript: null, now: Date.now(),
};
