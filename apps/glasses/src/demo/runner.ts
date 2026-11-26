import type { GlassesGesture } from '../sdk/types';
import { DEMO_STEPS, VOICE_GAP_MS, type DemoStep } from './script';

/** What the autopilot needs from the app. Implemented over PulseController in driver.ts; faked in tests. */
export interface DemoDriver {
  /** Reset demo data (watchlist, pending proposals, plans, empty sessions) and start a fresh session. */
  prepare(): Promise<void>;
  say(text: string): Promise<void>;
  /** Wait `leadMs` (the narration), then play a recorded spoken request through the real voice pipeline. */
  voice(clip: string, leadMs: number): Promise<void>;
  /** Perform a gesture and resolve once any work it triggered has finished. */
  gesture(g: GlassesGesture): Promise<void>;
  /** Resolve when the armed plan has fired and its proposal is on screen. */
  waitAlert(): Promise<void>;
  /** End the session and start a new one showing the greeting. */
  restart(): Promise<void>;
}

export type StepStatus = 'running' | 'dwelling' | 'done' | 'error';

export interface DemoHooks {
  onStep?: (index: number, step: DemoStep, status: StepStatus, error?: string) => void;
  onCountdown?: (secondsLeft: number) => void;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  /** 1 = normal; below 1 shortens the holds (the voiceover is made for 1). */
  pace?: number;
  countdownSeconds?: number;
}

export interface DemoResult {
  completed: number;
  errors: Array<{ step: string; message: string }>;
  aborted: boolean;
}

export const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

/** Time to read the screen before the swipe, and to see the highlighted choice before the tap. */
export const CONFIRM_LEAD_MS = 700;
export const CONFIRM_PAUSE_MS = 1400;

/** How long to keep holding after the action: until the narration has been spoken, with a short minimum to read. */
export function holdMs(step: Pick<DemoStep, 'voiceMs'>, actionMs: number, pace = 1): number {
  return Math.max(1500, step.voiceMs + VOICE_GAP_MS - actionMs) * pace;
}

/** Runs the scripted demo. A failing step is reported and the run continues, so one slow call never ruins a take. */
export async function runDemo(driver: DemoDriver, hooks: DemoHooks = {}, steps: readonly DemoStep[] = DEMO_STEPS): Promise<DemoResult> {
  const sleep = hooks.sleep ?? abortableSleep;
  const now = hooks.now ?? Date.now;
  const pace = hooks.pace ?? 1;
  const { signal } = hooks;
  const result: DemoResult = { completed: 0, errors: [], aborted: false };

  await driver.prepare();
  for (let s = hooks.countdownSeconds ?? 0; s > 0 && !signal?.aborted; s--) {
    hooks.onCountdown?.(s);
    await sleep(1000, signal);
  }
  hooks.onCountdown?.(0);

  for (let i = 0; i < steps.length; i++) {
    if (signal?.aborted) { result.aborted = true; break; }
    const step = steps[i]!;
    const startedAt = now();
    hooks.onStep?.(i, step, 'running');
    try {
      const a = step.action;
      if (a.type === 'say') await driver.say(a.text);
      else if (a.type === 'gesture') await driver.gesture(a.gesture);
      else if (a.type === 'confirm') {
        await sleep(CONFIRM_LEAD_MS * pace, signal);
        await driver.gesture('swipe_down');
        await sleep(CONFIRM_PAUSE_MS * pace, signal);
        if (!signal?.aborted) await driver.gesture('click');
      }
      else if (a.type === 'voice') await driver.voice(a.clip, step.voiceMs);
      else if (a.type === 'waitAlert') await driver.waitAlert();
      else if (a.type === 'restart') await driver.restart();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'step failed';
      result.errors.push({ step: step.id, message });
      hooks.onStep?.(i, step, 'error', message);
    }
    hooks.onStep?.(i, step, 'dwelling');
    await sleep(holdMs(step, now() - startedAt, pace), signal);
    hooks.onStep?.(i, step, 'done');
    result.completed++;
  }
  if (signal?.aborted) result.aborted = true;
  return result;
}
