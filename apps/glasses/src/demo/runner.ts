import type { GlassesGesture } from '../sdk/types';
import { DEMO_STEPS, type DemoStep } from './script';

/** What the autopilot needs from the app. Implemented over PulseController in App.tsx; faked in tests. */
export interface DemoDriver {
  /** Reset demo data (watchlist, pending proposals, empty sessions) and start a fresh session. */
  prepare(): Promise<void>;
  say(text: string): Promise<void>;
  /** Perform a gesture and resolve once any work it triggered has finished. */
  gesture(g: GlassesGesture): Promise<void>;
  endSession(): Promise<void>;
  newSession(): Promise<void>;
}

export type StepStatus = 'running' | 'dwelling' | 'done' | 'error';

export interface DemoHooks {
  onStep?: (index: number, step: DemoStep, status: StepStatus, error?: string) => void;
  onCountdown?: (secondsLeft: number) => void;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  /** 1 = normal; 0.7 = faster cut. */
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

/** Runs the scripted demo. A failing step is reported and the run continues, so one slow call never ruins a take. */
export async function runDemo(driver: DemoDriver, hooks: DemoHooks = {}, steps: readonly DemoStep[] = DEMO_STEPS): Promise<DemoResult> {
  const sleep = hooks.sleep ?? abortableSleep;
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
    hooks.onStep?.(i, step, 'running');
    try {
      const a = step.action;
      if (a.type === 'say') await driver.say(a.text);
      else if (a.type === 'gesture') await driver.gesture(a.gesture);
      else if (a.type === 'endSession') await driver.endSession();
      else if (a.type === 'newSession') await driver.newSession();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'step failed';
      result.errors.push({ step: step.id, message });
      hooks.onStep?.(i, step, 'error', message);
    }
    hooks.onStep?.(i, step, 'dwelling');
    await sleep(step.dwellMs * pace, signal);
    hooks.onStep?.(i, step, 'done');
    result.completed++;
  }
  if (signal?.aborted) result.aborted = true;
  return result;
}
