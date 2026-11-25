/**
 * PULSE's own hardware abstraction. These are application interfaces, NOT SDK signatures:
 * EvenHubAdapter maps the real @evenrealities/even_hub_sdk onto them.
 */
export interface GlassesView {
  /** One line, brightest (wordmark / screen title). */
  header: string;
  /** Up to 6 short lines. */
  body: string[];
  /** One line, dimmest (hints, freshness). */
  footer: string;
}

export type GlassesGesture = 'click' | 'double_click' | 'swipe_up' | 'swipe_down' | 'long_press';

/** 16 kHz, signed 16-bit little-endian, mono PCM (Even SDK microphone format). */
export interface AudioInput {
  pcm: Uint8Array;
  source: 'glasses' | 'phone' | 'test';
}

export interface GlassesAdapter {
  readonly kind: 'even-hub' | 'simulator';
  initialize(): Promise<void>;
  render(view: GlassesView): Promise<void>;
  startListening(): Promise<void>;
  stopListening(): Promise<void>;
  onGesture(callback: (gesture: GlassesGesture) => void): () => void;
  onAudio(callback: (audio: AudioInput) => void): () => void;
  dispose(): Promise<void>;
}
