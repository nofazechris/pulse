import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Diagnostics, Memory } from '@pulse/shared';
import type { ApiClient } from './services/api';
import type { PulseController } from './state/controller';
import { runDemo, type DemoDriver } from './demo/runner';
import { DEMO_STEPS, totalDwellMs, type DemoStep } from './demo/script';

const QUICK = [
  'start my trading session', 'show my portfolio', "what's my biggest holding", 'how is bitcoin performing',
  'price of ethereum', 'show my watchlist', 'buy 20 usdt of btc', 'approve', 'reject', 'what happened to my last order',
];

interface Props {
  controller: PulseController;
  api: ApiClient;
  apiUrl: string;
  adapterKind: string;
  bridgeNote: string;
  driver: DemoDriver;
}

/**
 * Phone-side companion (WebView). The glasses UI is drawn by the SDK; this panel provides what the glasses
 * cannot: pairing, transcript-input mode (typed "voice"), a live preview of the glasses view, diagnostics
 * and memory review/delete.
 */
interface DemoUi {
  running: boolean;
  index: number;
  step: DemoStep | null;
  status: string;
  countdown: number;
  startedAt: number;
  elapsed: number;
  errors: string[];
  finished: boolean;
}
const idleDemo: DemoUi = { running: false, index: -1, step: null, status: '', countdown: 0, startedAt: 0, elapsed: 0, errors: [], finished: false };
const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export function App({ controller, api, apiUrl, adapterKind, bridgeNote, driver }: Props) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [diagErr, setDiagErr] = useState<string | null>(null);
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const view = controller.view;
  const [demo, setDemo] = useState<DemoUi>(idleDemo);
  const [fast, setFast] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const autoRan = useRef(false);

  const startDemo = useCallback((countdownSeconds: number) => {
    if (abortRef.current) return;
    const ctl = new AbortController();
    abortRef.current = ctl;
    const startedAt = Date.now();
    setDemo({ ...idleDemo, running: true, startedAt, countdown: countdownSeconds });
    const tick = setInterval(() => setDemo((d) => (d.running ? { ...d, elapsed: Date.now() - d.startedAt } : d)), 500);
    void runDemo(driver, {
      signal: ctl.signal, pace: fast ? 0.7 : 1, countdownSeconds,
      onCountdown: (n) => setDemo((d) => ({ ...d, countdown: n, startedAt: n === 0 ? Date.now() : d.startedAt })),
      onStep: (index, step, status, error) =>
        setDemo((d) => ({ ...d, index, step, status, errors: error ? [...d.errors, `${step.title}: ${error}`] : d.errors })),
    }).then((r) => {
      clearInterval(tick);
      abortRef.current = null;
      setDemo((d) => ({ ...d, running: false, finished: !r.aborted, elapsed: Date.now() - d.startedAt }));
    });
  }, [driver, fast]);

  const stopDemo = () => abortRef.current?.abort();

  // ?autorun=1&countdown=5 : used by `npm run demo` so you only have to press record.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (!q.has('autorun') || autoRan.current) return;
    if (state.authenticationStatus === 'authenticated' && state.currentScreen === 'home' && state.activeSessionId) {
      autoRan.current = true;
      if (q.get('pace') === 'fast') setFast(true);
      startDemo(Number(q.get('countdown') ?? 5));
    }
  }, [state.authenticationStatus, state.currentScreen, state.activeSessionId, startDemo]);

  const runDiag = useCallback(async () => {
    try {
      setDiag(await api.diagnostics());
      setDiagErr(null);
    } catch (e) {
      setDiagErr(e instanceof Error ? e.message : 'failed');
    }
  }, [api]);

  const loadMem = useCallback(async () => {
    try {
      setMemories(await controller.loadMemories());
    } catch {
      setMemories(null);
    }
  }, [controller]);

  useEffect(() => {
    if (state.authenticationStatus === 'authenticated') {
      void runDiag();
      void loadMem();
    }
  }, [state.authenticationStatus, state.activeSessionId, runDiag, loadMem]);

  const send = (t: string) => {
    if (!t.trim()) return;
    void controller.submitText(t, 'text').then(() => void loadMem());
    setText('');
  };

  return (
    <main className="panel">
      <h1>PULSE</h1>
      <p className="tag">Your financial world, at a glance. {state.mode === 'DEMO' ? <b className="demo">DEMO MODE - SIMULATED DATA</b> : <b>BINANCE SPOT TESTNET</b>}</p>

      {(demo.running || demo.finished) && (
        <section className="demo" aria-label="demo autopilot">
          {demo.countdown > 0 ? (
            <p className="big">Recording starts in {demo.countdown}...</p>
          ) : (
            <>
              <p className="dim">
                DEMO {Math.max(0, demo.index + 1)}/{DEMO_STEPS.length} - {mmss(demo.elapsed)} {demo.finished ? '- FINISHED' : demo.running ? '(autopilot)' : ''}
              </p>
              {demo.step && <p className="big">{demo.step.title}</p>}
              {demo.step?.action.type === 'say' && <p className="say">SAY: "{demo.step.action.text}"</p>}
              {demo.step?.action.type === 'gesture' && <p className="say">GESTURE: {demo.step.action.gesture.replace('_', ' ')}</p>}
              {demo.step && <p className="narr">{demo.step.narration}</p>}
              {demo.errors.length > 0 && <p className="err">{demo.errors.join(' | ')}</p>}
            </>
          )}
        </section>
      )}

      {state.authenticationStatus !== 'authenticated' && (
        <section>
          <h2>Pair this device</h2>
          <form onSubmit={(e) => { e.preventDefault(); void controller.pair(code); setCode(''); }}>
            <input type="password" autoComplete="off" placeholder="pairing code" value={code} onChange={(e) => setCode(e.target.value)} />
            <button type="submit">Pair</button>
          </form>
          {state.lastError && <p className="err">{state.lastError}</p>}
        </section>
      )}

      {state.authenticationStatus === 'authenticated' && (
        <section>
          <h2>Demo autopilot</h2>
          <p className="dim">Runs the scripted ~{Math.round(totalDwellMs(DEMO_STEPS, fast ? 0.7 : 1) / 1000 + 50)} s demo through the real app: real Binance Testnet data and ONE small approved testnet order. Start your screen recorder first.</p>
          {!demo.running ? (
            <>
              <button onClick={() => startDemo(5)}>Run demo (5 s countdown)</button>{' '}
              <label className="dim"><input type="checkbox" checked={fast} onChange={(e) => setFast(e.target.checked)} /> faster cut</label>
            </>
          ) : (
            <button onClick={stopDemo}>Stop demo</button>
          )}
        </section>
      )}

      <section>
        <h2>Glasses view (576x288, monochrome)</h2>
        <pre className="glass" aria-label="glasses preview">{`${view.header}\n${'-'.repeat(46)}\n${view.body.join('\n')}\n${'-'.repeat(46)}\n${view.footer}`}</pre>
        <p className="dim">voice: {state.voiceState} | screen: {state.currentScreen}</p>
      </section>

      <section>
        <h2>Talk to PULSE (transcript input)</h2>
        <form onSubmit={(e) => { e.preventDefault(); send(text); }}>
          <input placeholder='e.g. "buy 20 USDT of BTC"' value={text} onChange={(e) => setText(e.target.value)} disabled={state.authenticationStatus !== 'authenticated'} />
          <button type="submit" disabled={state.voiceState === 'PROCESSING'}>Send</button>
        </form>
        <div className="chips">
          {QUICK.map((q) => (
            <button key={q} className="chip" onClick={() => send(q)} disabled={state.voiceState === 'PROCESSING'}>{q}</button>
          ))}
        </div>
        <div className="chips">
          {(['swipe_up', 'swipe_down', 'click', 'double_click', 'long_press'] as const).map((g) => (
            <button key={g} className="chip" onClick={() => controller.onGesture(g)}>{g.replace('_', ' ')}</button>
          ))}
        </div>
        {state.lastTranscript && <p className="dim">last transcript: {state.lastTranscript}</p>}
      </section>

      <section>
        <h2>Diagnostics</h2>
        <dl>
          <dt>SDK / adapter</dt><dd>{adapterKind} - {bridgeNote}</dd>
          <dt>Backend ({apiUrl})</dt><dd>{state.backend}</dd>
          <dt>Database</dt><dd>{diag ? `${diag.database.status} (${diag.database.latencyMs ?? '-'} ms)` : '...'}</dd>
          <dt>Binance Testnet</dt><dd>{diag ? `${diag.exchange.status} (${diag.exchange.latencyMs ?? '-'} ms), last update ${diag.exchange.lastUpdate?.slice(11, 19) ?? '-'}` : '...'}</dd>
          <dt>AI provider</dt><dd>{diag ? `${diag.ai.provider}${diag.ai.configured ? '' : ' (not configured: deterministic fallback)'}` : '...'}</dd>
          <dt>Speech-to-text</dt><dd>{diag ? `${diag.stt.provider}${diag.stt.configured ? '' : ' (not configured: use text input)'}` : '...'}</dd>
          <dt>Last request id</dt><dd>{api.lastRequestId ?? '-'}</dd>
          <dt>Last error</dt><dd>{state.lastError ?? diagErr ?? api.lastError ?? '-'}</dd>
        </dl>
        <button className="chip" onClick={() => void runDiag()}>Refresh</button>
      </section>

      <section>
        <h2>Memory (review / delete)</h2>
        {memories === null ? <p className="dim">Pair to load.</p> : memories.length === 0 ? <p className="dim">Nothing remembered yet. Say "remember that ...".</p> : (
          <ul>
            {memories.map((m) => (
              <li key={m.id}>
                <span className="dim">[{m.category}]</span> {m.content}{' '}
                <button className="chip" onClick={() => void api.deleteMemory(m.id).then(loadMem)}>delete</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Session</h2>
        <button className="chip" onClick={() => void controller.endSession().then(() => controller.newSession()).then(loadMem)}>End session &amp; start new</button>
        <pre className="log">{controller.log.slice(-8).join('\n') || '(no events yet)'}</pre>
      </section>
    </main>
  );
}
