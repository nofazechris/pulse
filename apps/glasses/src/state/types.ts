import type { AgentReply, ExecuteResult, MarketStats, Portfolio, TradeProposal, Watchlist } from '@pulse/shared';

export type ScreenId = 'connection' | 'home' | 'portfolio' | 'market' | 'watchlist' | 'insight' | 'proposal' | 'result' | 'error';
export type VoiceState = 'IDLE' | 'LISTENING' | 'PROCESSING' | 'RESPONDING' | 'AWAITING_APPROVAL' | 'ERROR';
export type ConnectionStatus = 'initializing' | 'connected' | 'reconnecting' | 'offline' | 'auth_required' | 'exchange_unavailable';
export type AuthStatus = 'unauthenticated' | 'pairing' | 'authenticated';

export interface PulseState {
  connectionStatus: ConnectionStatus;
  authenticationStatus: AuthStatus;
  currentScreen: ScreenId;
  voiceState: VoiceState;
  mode: 'LIVE' | 'DEMO';
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
  mode: 'LIVE', backend: 'unknown', exchange: 'unknown',
  portfolio: null, watchlist: null, market: null, marketSymbol: null,
  activeSessionId: null, activeProposal: null, approvalChoice: 'REJECT', lastReply: null, lastResult: null,
  listIndex: 0, scroll: 0, notice: null, retryOrder: false, lastError: null, lastTranscript: null, now: Date.now(),
};
