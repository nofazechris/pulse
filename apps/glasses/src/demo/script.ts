import type { GlassesGesture } from '../sdk/types';
import durations from './durations.json';
import narration from './narration.json';

/**
 * The scripted demo (about 2.5 minutes of app footage between a title and a closing card). Every step is
 * something a real wearer would say or do; the autopilot performs it through the same controller the glasses
 * use, so it exercises the real backend, the real Binance Testnet and the real approval flow.
 * `narration.json` is both the on-screen teleprompter and the voiceover text; `durations.json` holds the
 * measured length of each voice clip (scripts/make-voiceover.mjs), so each step is held until it is spoken.
 */
export type DemoAction =
  | { type: 'none' }
  /** `{BTC_NEAR}` is replaced at run time with a level just above the live price (so the plan fires on camera). */
  | { type: 'say'; text: string }
  /** Recorded speech in public/demo/<clip>.wav, transcribed live by the real speech-to-text. */
  | { type: 'voice'; clip: string }
  /** Swipe to the second choice (APPROVE, or CANCEL IT), pause so it can be seen, then tap. */
  | { type: 'confirm' }
  | { type: 'gesture'; gesture: GlassesGesture }
  /** Wait for the armed trade plan to fire and put its prepared order on the glasses. */
  | { type: 'waitAlert' }
  /** End the session and start a new one that greets the returning wearer. */
  | { type: 'restart' };

export type NarrationId = keyof typeof narration;

export interface DemoStep {
  id: Exclude<NarrationId, 'title' | 'how' | 'who' | 'closing'>;
  /** Short heading shown in the panel and in the video caption. */
  title: string;
  narration: string;
  action: DemoAction;
  /** Length of the spoken line; the step is held at least this long. */
  voiceMs: number;
}

const step = (id: DemoStep['id'], title: string, action: DemoAction): DemoStep => ({
  id, title, action, narration: narration[id], voiceMs: (durations as Record<string, number>)[id] ?? 5000,
});

export const DEMO_STEPS: readonly DemoStep[] = [
  step('home', 'One glance', { type: 'none' }),
  step('start', 'Start a session', { type: 'say', text: 'Pulse, start my trading session' }),
  step('holding', 'Biggest holding', { type: 'say', text: "What's my biggest holding?" }),
  step('voice', 'Real voice', { type: 'voice', clip: 'wearer-btc' }),
  step('why', 'Why is it moving?', { type: 'say', text: 'Why is Bitcoin moving today?' }),
  step('plan', 'Trade plans', { type: 'say', text: 'Alert me if Bitcoin is below {BTC_NEAR} and buy 20 dollars' }),
  step('fired', 'Plan fired', { type: 'waitAlert' }),
  step('choose', 'Safe by default', { type: 'gesture', gesture: 'swipe_down' }),
  step('approve', 'Approve', { type: 'gesture', gesture: 'click' }),
  step('session', 'Session P&L', { type: 'say', text: 'How is my session?' }),
  step('sell', 'Sell half', { type: 'say', text: 'Sell half my Bitcoin at {BTC_HIGH}' }),
  step('place', 'Place the order', { type: 'confirm' }),
  step('cancel', 'Cancel by voice', { type: 'say', text: 'Cancel my order' }),
  step('confirm', 'Confirmed cancel', { type: 'confirm' }),
  step('remember', 'Memory', { type: 'say', text: 'Remember that I focus on BTC and ETH' }),
  step('again', 'Welcome back', { type: 'restart' }),
];

/** Silence after each spoken line. */
export const VOICE_GAP_MS = 500;
export const totalSpeechMs = (steps: readonly DemoStep[] = DEMO_STEPS) => steps.reduce((n, s) => n + s.voiceMs + VOICE_GAP_MS, 0);
