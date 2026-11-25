import type { AudioInput, GlassesAdapter, GlassesGesture, GlassesView } from './types';

/**
 * In-memory adapter for automated tests and for opening the app in a plain browser (no Even bridge).
 * It records every rendered view and lets a test inject gestures and microphone audio.
 * (The official Even Hub simulator itself talks to the app through the real SDK, i.e. via EvenHubAdapter.)
 */
export class SimulatorAdapter implements GlassesAdapter {
  readonly kind = 'simulator' as const;
  views: GlassesView[] = [];
  listening = false;
  listenStarts = 0;
  private gestureCbs = new Set<(g: GlassesGesture) => void>();
  private audioCbs = new Set<(a: AudioInput) => void>();

  get lastView(): GlassesView | undefined {
    return this.views.at(-1);
  }
  async initialize() {}
  async render(view: GlassesView) {
    this.views.push(view);
  }
  async startListening() {
    this.listening = true;
    this.listenStarts++;
  }
  async stopListening() {
    this.listening = false;
  }
  onGesture(cb: (g: GlassesGesture) => void) {
    this.gestureCbs.add(cb);
    return () => this.gestureCbs.delete(cb);
  }
  onAudio(cb: (a: AudioInput) => void) {
    this.audioCbs.add(cb);
    return () => this.audioCbs.delete(cb);
  }
  async dispose() {
    this.gestureCbs.clear();
    this.audioCbs.clear();
  }

  /** Test helpers. */
  emitGesture(g: GlassesGesture) {
    this.gestureCbs.forEach((cb) => cb(g));
  }
  emitAudio(pcm: Uint8Array) {
    this.audioCbs.forEach((cb) => cb({ pcm, source: 'test' }));
  }
}
