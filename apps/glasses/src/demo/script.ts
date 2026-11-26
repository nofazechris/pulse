import type { GlassesGesture } from '../sdk/types';

/**
 * The scripted 3-minute demo. Every step is something a real wearer would say or do; the autopilot
 * performs it through the same controller the glasses use (typed transcripts + gestures), so it exercises
 * the real backend, the real Binance Testnet and the real approval flow. The narration is a teleprompter.
 */
export type DemoAction =
  | { type: 'none' }
  | { type: 'say'; text: string }
  | { type: 'gesture'; gesture: GlassesGesture }
  | { type: 'endSession' }
  | { type: 'newSession' };

export interface DemoStep {
  id: string;
  /** Short heading shown in the panel. */
  title: string;
  /** What to say out loud over the recording (teleprompter text). */
  narration: string;
  action: DemoAction;
  /** How long to hold the result on screen after the action completes (before pace scaling). */
  dwellMs: number;
}

export const DEMO_STEPS: readonly DemoStep[] = [
  { id: 'intro', title: 'Glanceable home', narration: 'This is PULSE on Even G2. One glance: my testnet portfolio, today\'s move, and live prices - all from Binance.', action: { type: 'none' }, dwellMs: 5000 },
  { id: 'start', title: 'Start a session', narration: 'One phrase starts my trading session. The greeting is built only from verified exchange data.', action: { type: 'say', text: 'Pulse, start my trading session' }, dwellMs: 6000 },
  { id: 'holding', title: 'Read: biggest holding', narration: 'I ask about my biggest holding. Real balances, valued in USDT, with unpriced testnet junk excluded.', action: { type: 'say', text: "What's my biggest holding?" }, dwellMs: 6500 },
  { id: 'perf', title: 'Read: market', narration: 'Bitcoin\'s price, 24-hour move, high and low, and how old the data is.', action: { type: 'say', text: 'How is Bitcoin performing?' }, dwellMs: 6000 },
  { id: 'why', title: 'Honest answers', narration: 'I ask why. PULSE gives verified facts and says plainly it cannot verify the cause. No invented news.', action: { type: 'say', text: 'Why is Bitcoin moving today?' }, dwellMs: 5000 },
  { id: 'why-scroll', title: 'Facts vs unverified', narration: 'Facts, AI view and unverified claims are labelled separately.', action: { type: 'gesture', gesture: 'swipe_down' }, dwellMs: 5000 },
  { id: 'watch', title: 'Write: watchlist', narration: 'Adding Solana to my watchlist is saved to Neon and shows live prices.', action: { type: 'say', text: 'Add SOL to my watchlist' }, dwellMs: 5000 },
  { id: 'prepare', title: 'Prepare a trade', narration: 'Now a trade. PULSE prepares a proposal with exact terms and a TESTNET banner. REJECT is preselected, so nothing happens by accident.', action: { type: 'say', text: 'Prepare a $50 BTC buy' }, dwellMs: 8000 },
  { id: 'choose', title: 'Choose APPROVE', narration: 'I swipe to choose APPROVE.', action: { type: 'gesture', gesture: 'swipe_down' }, dwellMs: 3000 },
  { id: 'approve', title: 'Approve and execute', narration: 'One tap approves exactly this proposal. The backend re-validates it, Binance executes it, and the screen shows what Binance confirmed, with the order id.', action: { type: 'gesture', gesture: 'click' }, dwellMs: 9000 },
  { id: 'status', title: 'Read after write', narration: 'I can check that order any time; the status comes straight from Binance.', action: { type: 'say', text: 'What happened to my last order?' }, dwellMs: 6000 },
  { id: 'remember', title: 'Persistent memory', narration: 'I tell PULSE a preference. It is stored in Neon and only explicit statements are remembered.', action: { type: 'say', text: 'Remember that I focus on BTC and ETH' }, dwellMs: 4000 },
  { id: 'end', title: 'End the session', narration: 'I end the session.', action: { type: 'endSession' }, dwellMs: 3000 },
  { id: 'again', title: 'Welcome back', narration: 'A new session: PULSE remembers my preference and what we did last time.', action: { type: 'newSession' }, dwellMs: 8000 },
  { id: 'outro', title: 'Safety', narration: 'Testnet only. No withdrawals, no margin, no autonomous trading. AI interprets, the backend validates, I authorize, Binance executes. This is PULSE.', action: { type: 'none' }, dwellMs: 6000 },
];

export const totalDwellMs = (steps: readonly DemoStep[] = DEMO_STEPS, pace = 1) => steps.reduce((n, s) => n + s.dwellMs * pace, 0);
