import type { AgentReply, Memory, PlanAlert, TradeProposal } from '@pulse/shared';
import { renderScreen } from '../screens';
import type { AudioInput, GlassesAdapter, GlassesGesture, GlassesView } from '../sdk/types';
import { PRACTICE_REQUESTS } from '../practice/requests';
import { ApiRequestError, type PulseApi } from '../services/api';
import type { TokenStore } from '../services/tokenStore';
import { initialState, type PendingCancel, type PulseState, type ScreenId } from './types';

export const LISTEN_MAX_MS = 15_000;
export const PROCESS_TIMEOUT_MS = 30_000;
export const GESTURE_DEDUPE_MS = 180;
/** How often armed trade plans are checked while the app is open. */
export const PLAN_POLL_MS = 7_000;
const CYCLE: ScreenId[] = ['home', 'portfolio', 'market', 'watchlist'];
/** An alert may only appear over calm screens: never while the wearer is speaking, deciding or in an error. */
const ALERTABLE: ReadonlySet<ScreenId> = new Set(['home', 'portfolio', 'market', 'watchlist', 'insight', 'result']);
const MIN_PCM_BYTES = 3200; // 100 ms of 16 kHz 16-bit mono

export interface ControllerOptions {
  adapter: GlassesAdapter;
  api: PulseApi;
  tokens: TokenStore;
  /** Creates the no-server practice backend; omit to leave practice mode unavailable. */
  practice?: () => { api: PulseApi; tokens: TokenStore };
  /** Dev-only convenience (VITE_DEMO_PAIRING_CODE): pair automatically. Never set for production builds. */
  autoPairCode?: string | undefined;
  deviceType?: 'simulator' | 'g2-glasses' | 'web';
  clock?: () => number;
}

type Listener = () => void;

/**
 * Orchestrates the glasses UI. All data comes from the backend; this class only holds UI state,
 * maps gestures to actions, runs the voice state machine and drives the approval flow.
 */
export class PulseController {
  private state: PulseState = { ...initialState };
  private listeners = new Set<Listener>();
  private unsubs: Array<() => void> = [];
  private audio: Uint8Array[] = [];
  private listenTimer: ReturnType<typeof setTimeout> | null = null;
  private processTimer: ReturnType<typeof setTimeout> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private lastGesture = { g: '' as string, at: 0 };
  private busy = false;
  private seq = { data: 0, message: 0 };
  private abort: AbortController | null = null;
  private rendering = false;
  private pendingView: GlassesView | null = null;
  private idempotencyKeys = new Map<string, string>();
  private retry: { p: TradeProposal; method: 'glasses_gesture' | 'voice' } | null = null;
  readonly log: string[] = [];
  private readonly now: () => number;
  private lastPlanPoll = 0;
  private polling = false;
  private queuedAlert: PlanAlert | null = null;

  /** Set once, by an explicit choice: the real backend is not touched afterwards. */
  private practising: { api: PulseApi; tokens: TokenStore } | null = null;
  private generation = 0;

  constructor(private readonly o: ControllerOptions) {
    this.now = o.clock ?? Date.now;
    this.state = { ...this.state, canPractice: o.practice !== undefined };
  }

  get api(): PulseApi {
    return this.practising?.api ?? this.o.api;
  }
  private get tokens(): TokenStore {
    return this.practising?.tokens ?? this.o.tokens;
  }

  /** Switches to the practice backend (sample prices, simulated orders, labelled DEMO). */
  async startPractice(): Promise<void> {
    if (!this.o.practice || this.practising) return;
    this.practising = this.o.practice();
    this.abort?.abort();
    this.clearTimers();
    this.busy = false;
    this.retry = null;
    this.queuedAlert = null;
    this.set({ ...initialState, practice: true, canPractice: true, mode: 'DEMO' });
    await this.connect();
  }

  // ------------------------------------------------------------- store plumbing
  getState = (): PulseState => this.state;
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  get view(): GlassesView {
    return renderScreen(this.state);
  }

  private set(patch: Partial<PulseState>) {
    this.state = { ...this.state, ...patch, now: this.now() };
    this.listeners.forEach((l) => l());
    void this.draw();
  }
  private note(msg: string) {
    this.log.push(`${new Date(this.now()).toISOString().slice(11, 19)} ${msg}`);
    if (this.log.length > 40) this.log.shift();
    this.listeners.forEach((l) => l());
  }

  /** Latest-wins render queue: never overlap SDK updates, never draw stale views. */
  private async draw() {
    this.pendingView = renderScreen(this.state);
    if (this.rendering) return;
    this.rendering = true;
    try {
      while (this.pendingView) {
        const v = this.pendingView;
        this.pendingView = null;
        try {
          await this.o.adapter.render(v);
        } catch (err) {
          this.note(`render failed: ${err instanceof Error ? err.message : 'unknown'}`);
        }
      }
    } finally {
      this.rendering = false;
    }
  }

  // ------------------------------------------------------------- lifecycle
  async start(): Promise<void> {
    this.unsubs.push(this.o.adapter.onGesture((g) => this.onGesture(g)), this.o.adapter.onAudio((a) => this.onAudio(a)));
    this.tick = setInterval(() => {
      if (this.state.currentScreen === 'proposal') this.onProposalTick();
      void this.pollPlans();
    }, 1000);
    await this.connect();
  }

  async dispose(): Promise<void> {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    if (this.tick) clearInterval(this.tick);
    this.clearTimers();
    this.abort?.abort();
    await this.o.adapter.dispose();
  }

  async connect(): Promise<void> {
    const mine = ++this.generation;
    this.set({ connectionStatus: 'initializing', currentScreen: 'connection', lastError: null });
    try {
      const h = await this.api.health();
      if (mine !== this.generation) return; // a newer connection (practice mode) took over
      this.set({ backend: 'ok', exchange: h.exchange === 'available' ? 'ok' : 'down', connectionStatus: h.exchange === 'available' ? 'initializing' : 'exchange_unavailable' });
    } catch {
      if (mine !== this.generation) return;
      this.set({ backend: 'down', connectionStatus: 'offline', lastError: 'Cannot reach the PULSE backend.' });
      return;
    }
    if (!(await this.ensureAuth())) return;
    await this.beginSession();
  }

  private async ensureAuth(): Promise<boolean> {
    const stored = this.tokens.get();
    if (stored) {
      try {
        await this.api.session();
        this.set({ authenticationStatus: 'authenticated' });
        return true;
      } catch (err) {
        if (!(err instanceof ApiRequestError) || err.status !== 401) {
          this.set({ connectionStatus: 'offline', lastError: 'Cannot verify the session.' });
          return false;
        }
        this.tokens.clear();
      }
    }
    const code = this.practising ? 'practice' : this.o.autoPairCode;
    if (code) return this.pair(code, false);
    this.set({ authenticationStatus: 'unauthenticated', connectionStatus: 'auth_required', currentScreen: 'connection' });
    return false;
  }

  /** startAfter: begin a session once paired (manual pairing from the panel). connect() starts its own, so it passes false. */
  async pair(code: string, startAfter = true): Promise<boolean> {
    this.set({ authenticationStatus: 'pairing', lastError: null });
    try {
      const s = await this.api.pair(code, this.o.deviceType ?? 'simulator');
      this.tokens.set({ token: s.accessToken, expiresAt: s.expiresAt });
      this.set({ authenticationStatus: 'authenticated' });
      this.note('paired');
      if (startAfter && !this.state.activeSessionId) void this.beginSession();
      return true;
    } catch (err) {
      this.set({ authenticationStatus: 'unauthenticated', connectionStatus: 'auth_required', currentScreen: 'connection', lastError: err instanceof ApiRequestError ? err.message : 'Pairing failed.' });
      return false;
    }
  }

  private async beginSession(showGreeting = false): Promise<void> {
    try {
      const { session, greeting } = await this.api.startSession();
      const mode = (greeting.data as { mode?: string } | undefined)?.mode === 'DEMO' ? 'DEMO' : 'LIVE';
      this.set({ activeSessionId: session.id, lastReply: greeting, mode, connectionStatus: 'connected' });
      await this.loadHome();
      await this.refreshPlanCount();
      this.set({ currentScreen: showGreeting ? 'insight' : 'home', scroll: 0 });
      this.note('session started');
    } catch (err) {
      this.fail(err);
    }
  }

  // ------------------------------------------------------------- trade plans
  private async refreshPlanCount() {
    try {
      this.set({ armedPlans: (await this.api.plans()).length });
    } catch {
      // Plans are an extra: never block the session because the count is unavailable.
    }
  }

  private canShowAlert(): boolean {
    return this.state.voiceState === 'IDLE' && !this.busy && ALERTABLE.has(this.state.currentScreen);
  }

  /** Called every second by the tick; checks at most every PLAN_POLL_MS, and only while something is armed. */
  async pollPlans(force = false): Promise<void> {
    if (this.queuedAlert && this.canShowAlert()) return this.showAlert(this.queuedAlert);
    const sessionId = this.state.activeSessionId;
    if (!sessionId || this.polling || this.state.armedPlans === 0 || !this.canShowAlert()) return;
    if (!force && this.now() - this.lastPlanPoll < PLAN_POLL_MS) return;
    this.polling = true;
    this.lastPlanPoll = this.now();
    try {
      const r = await this.api.checkPlans(sessionId);
      if (sessionId !== this.state.activeSessionId) return;
      this.set({ armedPlans: r.armed });
      const alert = r.alerts[0];
      if (!alert) return;
      this.note('plan fired');
      if (this.canShowAlert()) this.showAlert(alert);
      else this.queuedAlert = alert; // the wearer got busy meanwhile: show it when they are free
    } catch (err) {
      this.note(`plan check failed: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      this.polling = false;
    }
  }

  private showAlert(alert: PlanAlert) {
    this.queuedAlert = null;
    // With an order attached it lands on the normal approval screen (REJECT preselected); otherwise it is just news.
    if (alert.proposal) {
      this.showProposal(alert.proposal);
      this.set({ activeAlert: alert });
    } else this.set({ activeAlert: alert, currentScreen: 'alert', scroll: 0 });
  }

  // ------------------------------------------------------------- data loading (stale-response safe)
  private async loadHome() {
    const mine = ++this.seq.data;
    const [p, w] = await Promise.allSettled([this.api.portfolio(), this.api.watchlist()]);
    if (mine !== this.seq.data) return; // a newer request superseded this one
    this.set({
      portfolio: p.status === 'fulfilled' ? p.value : this.state.portfolio,
      watchlist: w.status === 'fulfilled' ? w.value : this.state.watchlist,
      exchange: p.status === 'fulfilled' || w.status === 'fulfilled' ? 'ok' : 'down',
    });
  }

  private async loadMarket(symbol: string) {
    const mine = ++this.seq.data;
    this.set({ marketSymbol: symbol });
    try {
      const m = await this.api.stats(symbol);
      if (mine === this.seq.data) this.set({ market: m });
    } catch (err) {
      if (mine === this.seq.data) this.fail(err);
    }
  }

  private async enter(screen: ScreenId) {
    this.retry = null;
    this.set({ currentScreen: screen, listIndex: 0, scroll: 0, notice: null, retryOrder: false });
    if (screen === 'home' || screen === 'portfolio') await this.loadHome();
    if (screen === 'watchlist') await this.loadHome();
    if (screen === 'market') {
      const sym = this.state.marketSymbol ?? this.state.watchlist?.items[0]?.symbol;
      if (sym) await this.loadMarket(sym);
    }
  }

  // ------------------------------------------------------------- gestures
  onGesture(g: GlassesGesture): void {
    const t = this.now();
    // Real devices can report one physical press through more than one event.
    if (this.lastGesture.g === g && t - this.lastGesture.at < GESTURE_DEDUPE_MS) return;
    this.lastGesture = { g, at: t };
    this.note(`gesture ${g}`);
    void this.handleGesture(g).catch((e) => this.fail(e));
  }

  private async handleGesture(g: GlassesGesture): Promise<void> {
    const s = this.state;

    if (s.voiceState === 'LISTENING') {
      if (g === 'double_click') return this.stopListeningAndSend();
      if (g === 'long_press') return this.cancelVoice();
      return;
    }
    if (s.voiceState === 'PROCESSING') {
      if (g === 'long_press') this.cancelVoice();
      return; // ignore everything else: no duplicate requests while busy
    }

    switch (s.currentScreen) {
      case 'connection':
        if (g === 'click') await this.connect();
        if (g === 'double_click') await this.startPractice();
        return;
      case 'try': {
        const n = PRACTICE_REQUESTS.length;
        if (g === 'swipe_down' || g === 'swipe_up') return this.set({ listIndex: (s.listIndex + (g === 'swipe_down' ? 1 : -1) + n) % n });
        if (g === 'click') return this.submitText(PRACTICE_REQUESTS[s.listIndex] ?? PRACTICE_REQUESTS[0]!);
        return this.enter('home');
      }
      case 'error':
        if (g === 'click' && this.retry) {
          const r = this.retry;
          return this.approveAndExecute(r.p, r.method, true);
        }
        if (g === 'click') return s.activeSessionId ? this.enter('home') : this.connect();
        if (g === 'long_press') return this.enter('home');
        return;
      case 'proposal':
        return this.proposalGesture(g);
      case 'cancel':
        return this.cancelGesture(g);
      case 'result':
      case 'alert':
        if (g === 'click' || g === 'long_press') return this.enter('home');
        if (g === 'double_click') return this.startListening();
        return;
      default:
        break;
    }

    if (g === 'double_click') return this.startListening();
    if (g === 'long_press') return this.enter('home');

    if (g === 'swipe_down' || g === 'swipe_up') {
      const dir = g === 'swipe_down' ? 1 : -1;
      if (s.currentScreen === 'watchlist' && s.watchlist) {
        const n = s.watchlist.items.length;
        if (n) this.set({ listIndex: Math.max(0, Math.min(n - 1, s.listIndex + dir)) });
        return;
      }
      if (s.currentScreen === 'portfolio' && s.portfolio) {
        this.set({ listIndex: Math.max(0, Math.min(Math.max(0, s.portfolio.balances.length - 3), s.listIndex + dir)) });
        return;
      }
      if (s.currentScreen === 'insight') {
        this.set({ scroll: Math.max(0, s.scroll + dir) });
        return;
      }
      if (s.currentScreen === 'market' && s.watchlist?.items.length) {
        const items = s.watchlist.items;
        const i = Math.max(0, items.findIndex((x) => x.symbol === s.marketSymbol));
        return this.loadMarket(items[(i + dir + items.length) % items.length]!.symbol);
      }
      // Home: swipe cycles the main screens.
      const i = Math.max(0, CYCLE.indexOf(s.currentScreen));
      return this.enter(CYCLE[(i + dir + CYCLE.length) % CYCLE.length]!);
    }

    if (g === 'click') {
      if (s.currentScreen === 'home') return this.enter('portfolio');
      if (s.currentScreen === 'portfolio') return this.enter('market');
      if (s.currentScreen === 'watchlist') {
        const sym = s.watchlist?.items[s.listIndex]?.symbol;
        this.set({ currentScreen: 'market' });
        if (sym) await this.loadMarket(sym);
        return;
      }
      return this.enter('home');
    }
  }

  // ------------------------------------------------------------- proposal / approval
  private async proposalGesture(g: GlassesGesture): Promise<void> {
    const p = this.state.activeProposal;
    if (!p || this.busy) return;
    if (g === 'swipe_up') return this.set({ approvalChoice: 'REJECT' });
    if (g === 'swipe_down') return this.set({ approvalChoice: 'APPROVE' });
    // Double-tap and long-press are always CANCEL on this screen. Only an explicit APPROVE selection + tap approves.
    if (g === 'double_click' || g === 'long_press') return this.rejectProposal(p);
    if (g === 'click') {
      if (this.state.approvalChoice === 'APPROVE') return this.approveAndExecute(p, 'glasses_gesture');
      return this.rejectProposal(p);
    }
  }

  private onProposalTick() {
    const p = this.state.activeProposal;
    if (p && new Date(p.expiresAt).getTime() <= this.now() && this.state.currentScreen === 'proposal' && !this.busy) {
      this.set({ activeProposal: null, currentScreen: 'home', voiceState: 'IDLE', notice: 'Proposal expired. Nothing was sent.' });
      return;
    }
    this.set({}); // refresh countdown
  }

  private showProposal(p: TradeProposal, notice?: string) {
    this.set({ activeAlert: null, activeProposal: p, approvalChoice: 'REJECT', currentScreen: 'proposal', voiceState: 'AWAITING_APPROVAL', notice: notice ?? null, scroll: 0 });
  }

  private async rejectProposal(p: TradeProposal) {
    this.busy = true;
    try {
      await this.api.reject(p.id, p.sessionId);
      this.set({ activeProposal: null, voiceState: 'IDLE', currentScreen: 'home', notice: 'Proposal cancelled. Nothing was sent.' });
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy = false;
    }
  }

  /** Approve exactly what is displayed (its hash), then execute. Execute carries NO trade parameters. */
  private async approveAndExecute(p: TradeProposal, method: 'glasses_gesture' | 'voice', alreadyApproved = false) {
    this.busy = true;
    this.set({ voiceState: 'PROCESSING' });
    let approved = alreadyApproved;
    try {
      if (!approved) {
        await this.api.approve(p.id, { sessionId: p.sessionId, proposalHash: p.proposalHash, method });
        approved = true;
      }
      const key = this.idempotencyKeys.get(p.id) ?? this.api.newIdempotencyKey();
      this.idempotencyKeys.set(p.id, key); // a retry of the same proposal reuses the key => no duplicate order
      const result = await this.api.execute(p.id, key);
      this.retry = null;
      this.set({ lastResult: result, activeProposal: null, currentScreen: 'result', voiceState: 'IDLE', retryOrder: false });
      void this.loadHome();
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'REQUOTE_REQUIRED') {
        const np = (err.details as { proposal?: TradeProposal } | undefined)?.proposal;
        if (np) {
          this.retry = null;
          this.showProposal(np, 'PRICE MOVED: review the new quote');
          return;
        }
      }
      // Approved but not confirmed: allow retrying the SAME order (same approval, same idempotency key => never a duplicate).
      const transient = err instanceof ApiRequestError && (err.isNetwork || err.status >= 500 || err.code === 'REQUEST_IN_PROGRESS');
      this.retry = approved && transient ? { p, method } : null;
      this.fail(err);
      if (this.retry) this.set({ retryOrder: true });
    } finally {
      this.busy = false;
    }
  }

  // ------------------------------------------------------------- cancelling a resting order
  /** KEEP is preselected; only an explicit CANCEL selection plus a tap cancels. */
  private async cancelGesture(g: GlassesGesture): Promise<void> {
    const c = this.state.pendingCancel;
    if (this.busy) return;
    if (!c || c.done) {
      if (g === 'double_click') return this.startListening();
      return this.enter('home');
    }
    if (g === 'swipe_up') return this.set({ cancelChoice: 'KEEP' });
    if (g === 'swipe_down') return this.set({ cancelChoice: 'CANCEL' });
    if (g === 'click' && this.state.cancelChoice === 'CANCEL') return this.cancelShownOrder(c);
    this.set({ pendingCancel: null, currentScreen: 'home', notice: 'Order kept. Nothing was changed.' });
  }

  private async cancelShownOrder(c: PendingCancel) {
    this.busy = true;
    this.set({ voiceState: 'PROCESSING' });
    try {
      const order = await this.api.cancelOrder(c.order.id);
      this.set({ pendingCancel: { ...c, order, done: true }, voiceState: 'IDLE' });
      void this.loadHome();
    } catch (err) {
      this.set({ pendingCancel: null });
      this.fail(err); // e.g. it filled in the meantime: the message says so
    } finally {
      this.busy = false;
    }
  }

  // ------------------------------------------------------------- voice state machine
  private clearTimers() {
    if (this.listenTimer) clearTimeout(this.listenTimer);
    if (this.processTimer) clearTimeout(this.processTimer);
    this.listenTimer = this.processTimer = null;
  }

  async startListening(): Promise<void> {
    if (this.busy || this.state.voiceState !== 'IDLE') return;
    // No speech service in practice mode: double-tap offers ready-made requests instead.
    if (this.practising) return this.set({ currentScreen: 'try', listIndex: 0, notice: null });
    this.audio = [];
    try {
      await this.o.adapter.startListening();
    } catch (err) {
      return this.fail(err);
    }
    this.set({ voiceState: 'LISTENING', lastError: null });
    this.listenTimer = setTimeout(() => void this.stopListeningAndSend(), LISTEN_MAX_MS);
  }

  private onAudio(a: AudioInput) {
    if (this.state.voiceState === 'LISTENING') this.audio.push(a.pcm);
  }

  async stopListeningAndSend(): Promise<void> {
    if (this.state.voiceState !== 'LISTENING') return;
    if (this.listenTimer) clearTimeout(this.listenTimer);
    await this.o.adapter.stopListening().catch(() => undefined);
    const total = this.audio.reduce((n, c) => n + c.length, 0);
    if (total < MIN_PCM_BYTES) {
      this.audio = [];
      this.set({ voiceState: 'ERROR', lastError: 'No audio captured. Type your request in the app instead.' });
      this.errorReset();
      return;
    }
    const pcm = new Uint8Array(total);
    let off = 0;
    for (const c of this.audio) { pcm.set(c, off); off += c.length; }
    this.audio = [];
    await this.transcribeAndSend(pcm);
  }

  /** Speech-to-text, then the same message path as typed text. */
  private async transcribeAndSend(pcm: Uint8Array): Promise<void> {
    this.beginProcessing();
    const ctl = this.abort!;
    try {
      const t = await this.api.transcribe(pcm, ctl.signal);
      this.set({ lastTranscript: t.text });
      await this.runMessage(t.text, 'voice', ctl);
    } catch (err) {
      if (ctl.signal.aborted) return;
      this.voiceFail(err);
    }
  }

  /**
   * Plays a recorded 16 kHz PCM clip through the voice pipeline (demo autopilot): the listening screen for the
   * clip's duration, then the real speech-to-text and the normal message path. The microphone stays closed.
   */
  async hearClip(pcm: Uint8Array): Promise<void> {
    if (this.busy || this.state.voiceState !== 'IDLE') return;
    this.set({ voiceState: 'LISTENING', lastError: null, lastTranscript: null });
    await new Promise((r) => setTimeout(r, Math.round(pcm.length / 32) + 300));
    if (this.getState().voiceState !== 'LISTENING') return; // cancelled meanwhile
    await this.transcribeAndSend(pcm);
  }

  private cancelVoice() {
    this.audio = [];
    this.clearTimers();
    this.abort?.abort();
    void this.o.adapter.stopListening().catch(() => undefined);
    this.busy = false;
    this.set({ voiceState: this.state.activeProposal ? 'AWAITING_APPROVAL' : 'IDLE', notice: 'Cancelled.' });
  }

  private beginProcessing() {
    this.abort?.abort();
    this.abort = new AbortController();
    this.set({ voiceState: 'PROCESSING' });
    const ctl = this.abort;
    this.processTimer = setTimeout(() => {
      ctl.abort();
      this.set({ voiceState: 'ERROR', lastError: 'That took too long. Try again.' });
      this.errorReset();
    }, PROCESS_TIMEOUT_MS);
  }

  private errorReset() {
    setTimeout(() => {
      if (this.state.voiceState === 'ERROR') this.set({ voiceState: this.state.activeProposal ? 'AWAITING_APPROVAL' : 'IDLE' });
    }, 3000);
  }

  private voiceFail(err: unknown) {
    this.clearTimers();
    if (err instanceof ApiRequestError && err.status === 401) return this.fail(err); // expired session: back to pairing
    this.set({ voiceState: 'ERROR', lastError: err instanceof ApiRequestError ? err.message : 'Something went wrong.' });
    this.errorReset();
  }

  /** Text/transcript entry (the always-available alternative to the microphone). */
  async submitText(text: string, source: 'voice' | 'text' = 'text'): Promise<void> {
    const clean = text.trim();
    if (!clean || this.busy) return;
    if (this.state.voiceState === 'PROCESSING') return; // duplicate-request guard
    if (this.state.voiceState === 'LISTENING') await this.o.adapter.stopListening().catch(() => undefined);
    this.beginProcessing();
    const ctl = this.abort!;
    try {
      await this.runMessage(clean, source, ctl);
    } catch (err) {
      if (!ctl.signal.aborted) this.voiceFail(err);
    }
  }

  private async runMessage(text: string, source: 'voice' | 'text', ctl: AbortController) {
    const sessionId = this.state.activeSessionId;
    if (!sessionId) throw new ApiRequestError(0, 'NO_SESSION', 'No active session yet.');
    const mine = ++this.seq.message;
    const displayed = this.state.currentScreen === 'proposal' ? this.state.activeProposal : null;
    const reply = await this.api.message({ sessionId, text, source, ...(displayed ? { displayedProposalId: displayed.id } : {}) }, ctl.signal);
    if (mine !== this.seq.message || ctl.signal.aborted) return; // stale
    this.clearTimers();
    this.set({ voiceState: 'RESPONDING', lastReply: reply, lastError: null });
    await this.applyReply(reply, displayed);
  }

  private async applyReply(reply: AgentReply, displayed: TradeProposal | null) {
    const a = reply.uiAction;
    if (reply.intent === 'CREATE_PLAN' || reply.intent === 'CANCEL_PLAN') {
      // Give the wearer a moment to read the confirmation before the first check can fire.
      this.lastPlanPoll = this.now();
      void this.refreshPlanCount();
    }
    if (a?.type === 'SHOW_PROPOSAL') return this.showProposal(a.proposal);
    if (a?.type === 'APPROVE_PROPOSAL') {
      // Voice only TRIGGERS approval of the proposal that is on screen; the client's displayed hash is what gets approved.
      if (displayed && displayed.id === a.proposalId && this.state.activeProposal?.id === displayed.id) {
        this.set({ voiceState: 'AWAITING_APPROVAL' });
        return this.approveAndExecute(displayed, 'voice');
      }
      // Mismatch: do not act, and keep the pending proposal on screen for an explicit decision.
      const keep = this.state.activeProposal;
      return this.set(keep
        ? { voiceState: 'AWAITING_APPROVAL', currentScreen: 'proposal', notice: 'Approval not matched. Review and confirm.' }
        : { voiceState: 'IDLE', currentScreen: 'insight', scroll: 0 });
    }
    if (a?.type === 'CONFIRM_CANCEL') {
      return this.set({
        pendingCancel: { order: a.order, price: a.price, openCount: a.openCount, done: false }, cancelChoice: 'KEEP',
        activeProposal: null, currentScreen: 'cancel', voiceState: 'IDLE', notice: null, scroll: 0,
      });
    }
    if (a?.type === 'REJECT_PROPOSAL') {
      return this.set({ activeProposal: null, voiceState: 'IDLE', currentScreen: 'home', notice: 'Proposal cancelled. Nothing was sent.' });
    }
    if (reply.data && (reply.data as { ended?: boolean }).ended) {
      return this.set({ voiceState: 'IDLE', currentScreen: 'insight', scroll: 0, activeSessionId: null });
    }
    // Data answers show their data screen; a balance answer is a sentence, so it stays on the insight screen.
    if (a?.type === 'NAVIGATE' && a.screen !== 'insight' && reply.intent !== 'GET_BALANCE') {
      const sym = (reply.data as { symbol?: string } | undefined)?.symbol;
      if (a.screen === 'market' && sym) {
        await this.loadMarket(sym); // one fetch; stay on the thinking screen until the right asset is here
        if (this.state.currentScreen === 'error') return;
        this.set({ currentScreen: 'market', listIndex: 0, scroll: 0, notice: null, retryOrder: false, voiceState: 'IDLE' });
        return;
      }
      await this.enter(a.screen);
      this.set({ voiceState: 'IDLE' });
      return;
    }
    this.set({ voiceState: 'IDLE', currentScreen: 'insight', scroll: 0 });
  }

  // ------------------------------------------------------------- misc
  private fail(err: unknown) {
    const message =
      err instanceof ApiRequestError
        ? err.status === 401 ? 'Session expired. Pair again.' : err.message
        : err instanceof Error ? err.message : 'Something went wrong.';
    if (err instanceof ApiRequestError && err.status === 401) {
      this.tokens.clear();
      this.set({ authenticationStatus: 'unauthenticated', connectionStatus: 'auth_required', currentScreen: 'connection', lastError: message, voiceState: 'IDLE' });
      return;
    }
    this.note(`error: ${message}`);
    this.set({ lastError: message, currentScreen: 'error', voiceState: 'IDLE', connectionStatus: err instanceof ApiRequestError && err.isNetwork ? 'offline' : this.state.connectionStatus });
  }

  async endSession(): Promise<void> {
    const id = this.state.activeSessionId;
    if (!id) return;
    await this.api.endSession(id);
    this.set({ activeSessionId: null });
  }

  /** `showGreeting`: land on the greeting (with remembered context) instead of Home. */
  async newSession(showGreeting = false): Promise<void> {
    await this.beginSession(showGreeting);
  }

  async loadMemories(): Promise<Memory[]> {
    return this.api.memories();
  }
}
