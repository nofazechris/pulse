import type { ApiClient } from '../services/api';
import type { PulseController } from '../state/controller';
import { abortableSleep, type DemoDriver } from './runner';

/**
 * A level a little above the live price, rounded to 50, so a "below" plan is met right away on camera.
 * Demo staging only (the narration says so); trading maths stays on the backend.
 */
export const nearAbove = (lastPrice: string): string => String(Math.ceil((Number(lastPrice) * 1.004) / 50) * 50);

/** A sell price well above the market (rounded to 500), so the demo's limit order rests instead of filling. */
export const farAbove = (lastPrice: string): string => String(Math.ceil((Number(lastPrice) * 1.15) / 500) * 500);

/** The PCM payload of a RIFF/WAVE file. */
export function wavPcm(buf: ArrayBuffer): Uint8Array {
  const view = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (buf.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  for (let off = 12; off + 8 <= buf.byteLength; ) {
    const size = view.getUint32(off + 4, true);
    if (tag(off) === 'data') return new Uint8Array(buf, off + 8, Math.min(size, buf.byteLength - off - 8));
    off += 8 + size + (size % 2);
  }
  throw new Error('WAV file has no audio data');
}

/** Drives the real controller exactly as the wearer would: typed transcripts and gestures. */
export function createControllerDriver(controller: PulseController, api: ApiClient): DemoDriver {
  const waitIdle = async (timeoutMs = 60_000) => {
    await abortableSleep(600); // let the action enter PROCESSING first
    const t0 = Date.now();
    while (controller.getState().voiceState === 'PROCESSING' && Date.now() - t0 < timeoutMs) await abortableSleep(250);
  };
  const waitFor = async (what: () => boolean, label: string, timeoutMs = 45_000) => {
    const t0 = Date.now();
    while (!what()) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`);
      await abortableSleep(300);
    }
  };
  return {
    async prepare() {
      await api.demoReset();
      await controller.newSession();
      await waitIdle();
    },
    async say(text) {
      let resolved = text;
      if (/\{BTC_(NEAR|HIGH)\}/.test(text)) {
        const { lastPrice } = await api.stats('BTCUSDT');
        resolved = text.replace('{BTC_NEAR}', nearAbove(lastPrice)).replace('{BTC_HIGH}', farAbove(lastPrice));
      }
      console.log(`[demo-say] ${resolved}`); // caption for the video recorder
      await controller.submitText(resolved, 'text');
      await waitIdle();
    },
    async voice(clip, leadMs) {
      const res = await fetch(`./demo/${clip}.wav`);
      if (!res.ok) throw new Error(`missing demo clip ${clip} (run scripts/make-voiceover.mjs)`);
      const pcm = wavPcm(await res.arrayBuffer());
      await abortableSleep(leadMs + 200); // let the narrator finish before the wearer speaks
      console.log(`[demo-voice] ${clip} ${Date.now()}`);
      await controller.hearClip(pcm);
      await waitIdle();
      const heard = controller.getState().lastTranscript;
      if (!heard) throw new Error(controller.getState().lastError ?? 'speech was not transcribed');
      console.log(`[demo-say] ${heard}`); // the caption shows what the speech service actually heard
    },
    async gesture(g) {
      controller.onGesture(g);
      await waitIdle();
    },
    async waitAlert() {
      await waitFor(() => controller.getState().currentScreen === 'proposal' && controller.getState().activeAlert !== null, 'the trade plan to fire');
    },
    async restart() {
      await controller.submitText('End my session', 'text');
      await waitIdle();
      await abortableSleep(1200);
      await controller.newSession(true);
      await waitIdle();
    },
  };
}
