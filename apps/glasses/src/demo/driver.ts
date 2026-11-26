import type { ApiClient } from '../services/api';
import type { PulseController } from '../state/controller';
import { abortableSleep, type DemoDriver } from './runner';

/** Drives the real controller exactly as the wearer would: typed transcripts and gestures. */
export function createControllerDriver(controller: PulseController, api: ApiClient): DemoDriver {
  const waitIdle = async (timeoutMs = 60_000) => {
    await abortableSleep(600); // let the action enter PROCESSING first
    const t0 = Date.now();
    while (controller.getState().voiceState === 'PROCESSING' && Date.now() - t0 < timeoutMs) await abortableSleep(250);
  };
  return {
    async prepare() {
      await api.demoReset();
      await controller.newSession();
      await waitIdle();
    },
    async say(text) {
      await controller.submitText(text, 'text');
      await waitIdle();
    },
    async gesture(g) {
      controller.onGesture(g);
      await waitIdle();
    },
    async endSession() {
      await controller.submitText('End my session', 'text');
      await waitIdle();
    },
    async newSession() {
      await controller.newSession(true);
      await waitIdle();
    },
  };
}
