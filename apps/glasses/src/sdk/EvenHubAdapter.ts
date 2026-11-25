import {
  AudioInputSource,
  CreateStartUpPageContainer,
  OsEventTypeList,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import { G2_DISPLAY } from '@pulse/shared';
import type { AudioInput, GlassesAdapter, GlassesGesture, GlassesView } from './types';

/**
 * Real adapter on top of the official Even Hub SDK (0.0.16). Works unchanged in the Even Hub simulator
 * and on a G2. Layout: three stacked full-width text containers (header / body / footer); only the body
 * captures input. Updates use textContainerUpgrade so the page never flickers.
 */
const LAYOUT = {
  header: { id: 1, name: 'pulse-hdr', y: 0, h: 44, brightness: 4, border: 0 },
  body: { id: 2, name: 'pulse-body', y: 44, h: 196, brightness: 3, border: 1 },
  footer: { id: 3, name: 'pulse-ftr', y: 240, h: 48, brightness: 2, border: 0 },
} as const;

export const BRIDGE_TIMEOUT_MS = 4000;
const INIT_TIMEOUT_MS = 8000;
const AUDIO_TIMEOUT_MS = 3000;

export class BridgeUnavailableError extends Error {
  constructor() {
    super('Even Hub bridge not available (open this app inside the Even Hub simulator or the Even app).');
    this.name = 'BridgeUnavailableError';
  }
}

export function gestureFromEvent(event: EvenHubEvent): GlassesGesture | null {
  const raw = event.textEvent ?? event.listEvent ?? event.sysEvent;
  if (!raw) return null;
  // The SDK may normalise CLICK (0) to undefined: a gesture event with no type is a click.
  const type = (raw as { eventType?: OsEventTypeList }).eventType ?? OsEventTypeList.CLICK_EVENT;
  switch (type) {
    case OsEventTypeList.CLICK_EVENT: return 'click';
    case OsEventTypeList.DOUBLE_CLICK_EVENT: return 'double_click';
    case OsEventTypeList.SCROLL_TOP_EVENT: return 'swipe_up';
    case OsEventTypeList.SCROLL_BOTTOM_EVENT: return 'swipe_down';
    case OsEventTypeList.LONG_PRESS_EVENT: return 'long_press';
    default: return null; // foreground/background, IMU, long-press release, etc.
  }
}

export class EvenHubAdapter implements GlassesAdapter {
  readonly kind = 'even-hub' as const;
  private bridge: EvenAppBridge | null = null;
  private gestureCbs = new Set<(g: GlassesGesture) => void>();
  private audioCbs = new Set<(a: AudioInput) => void>();
  private unsubscribe: (() => void) | null = null;
  private last = { header: '', body: '', footer: '' };
  private micOpen = false;

  /** Resolves the bridge or throws BridgeUnavailableError. Safe to call before initialize() to probe. */
  static async connect(): Promise<EvenAppBridge> {
    const bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<null>((r) => setTimeout(() => r(null), BRIDGE_TIMEOUT_MS)),
    ]);
    if (!bridge) throw new BridgeUnavailableError();
    return bridge;
  }

  async initialize(): Promise<void> {
    this.bridge ??= await EvenHubAdapter.connect();
    const mk = (l: (typeof LAYOUT)[keyof typeof LAYOUT], content: string, capture: boolean) =>
      new TextContainerProperty({
        xPosition: 0, yPosition: l.y, width: G2_DISPLAY.width, height: l.h, borderWidth: l.border, borderColor: 8,
        paddingLength: 8, containerID: l.id, containerName: l.name, content, textColor: l.brightness, isEventCapture: capture ? 1 : 0,
      });
    const startup = this.bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 3,
        textObject: [mk(LAYOUT.header, 'PULSE', false), mk(LAYOUT.body, 'Starting...', true), mk(LAYOUT.footer, ' ', false)],
      }),
    );
    // A host that never answers must not freeze the app: fail fast so the caller can fall back.
    const result = await Promise.race([startup, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('createStartUpPageContainer timed out')), INIT_TIMEOUT_MS))]);
    if (result !== StartUpPageCreateResult.success) {
      throw new Error(`createStartUpPageContainer failed: ${StartUpPageCreateResult[result]}`);
    }
    this.unsubscribe = this.bridge.onEvenHubEvent((event) => {
      if (event.audioEvent) {
        const a = event.audioEvent;
        this.audioCbs.forEach((cb) => cb({ pcm: a.audioPcm, source: String(a.source).toLowerCase().includes('phone') ? 'phone' : 'glasses' }));
        return;
      }
      const g = gestureFromEvent(event);
      if (g) this.gestureCbs.forEach((cb) => cb(g));
    });
  }

  async render(view: GlassesView): Promise<void> {
    if (!this.bridge) return;
    const next = { header: view.header || ' ', body: view.body.join('\n') || ' ', footer: view.footer || ' ' };
    for (const [key, l] of [['header', LAYOUT.header], ['body', LAYOUT.body], ['footer', LAYOUT.footer]] as const) {
      if (next[key] === this.last[key]) continue;
      const ok = await this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: l.id, containerName: l.name, content: next[key] }));
      if (ok) this.last[key] = next[key];
    }
  }

  async startListening(): Promise<void> {
    if (!this.bridge || this.micOpen) return;
    // A host that never answers must not freeze the UI in "starting to listen".
    const opened = await Promise.race([
      this.bridge.audioControl(true, AudioInputSource.Glasses),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Microphone did not respond')), AUDIO_TIMEOUT_MS)),
    ]);
    if (!opened) throw new Error('Microphone could not be opened');
    this.micOpen = true;
  }

  async stopListening(): Promise<void> {
    if (!this.bridge || !this.micOpen) return;
    await this.bridge.audioControl(false);
    this.micOpen = false;
  }

  onGesture(cb: (g: GlassesGesture) => void) {
    this.gestureCbs.add(cb);
    return () => this.gestureCbs.delete(cb);
  }
  onAudio(cb: (a: AudioInput) => void) {
    this.audioCbs.add(cb);
    return () => this.audioCbs.delete(cb);
  }

  async dispose(): Promise<void> {
    await this.stopListening().catch(() => undefined);
    this.unsubscribe?.();
    this.gestureCbs.clear();
    this.audioCbs.clear();
  }
}
