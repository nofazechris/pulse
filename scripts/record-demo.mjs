// Records the demo video from the Even Hub simulator and composes it with the voiceover. No screen capture:
// the exact 576x288 glasses frames come from the simulator's automation API, so nothing else on your desktop
// can end up in the video.
//
//   1. npm run dev                 (API + glasses dev server)
//   2. node scripts/make-voiceover.mjs        (once, or after editing narration.json)
//   3. npm run demo:record         (simulator with the autopilot and the automation port)
//   4. node scripts/record-demo.mjs capture
//   5. node scripts/record-demo.mjs compose   -> demo-video/pulse-demo.mp4
//
// Requires ffmpeg on PATH.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const cmd = process.argv[2] ?? 'capture';
const OUT = resolve('demo-video');
const FRAMES = join(OUT, 'frames');
const SIM = process.env.SIM_URL ?? 'http://127.0.0.1:9898';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function capture() {
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  const frames = [];
  const markers = [];
  let sinceId = -1;
  let endAt = 0;
  const hardStop = Date.now() + 330_000;
  process.stdout.write('waiting for the simulator and the autopilot...\n');
  for (;;) {
    try {
      const png = Buffer.from(await (await fetch(`${SIM}/api/screenshot/glasses`, { signal: AbortSignal.timeout(5000) })).arrayBuffer());
      const at = Date.now();
      const started = markers.some((m) => m.kind === 'step');
      const name = `f${String(frames.length).padStart(5, '0')}.png`;
      // Before the first step only keep the latest frame; afterwards keep everything.
      if (!started) frames.length = 0;
      writeFileSync(join(FRAMES, name), png);
      frames.push({ name, at });
      const log = await (await fetch(`${SIM}/api/console${sinceId >= 0 ? `?since_id=${sinceId}` : ''}`, { signal: AbortSignal.timeout(5000) })).json();
      for (const e of log.entries ?? []) {
        sinceId = Math.max(sinceId, e.id);
        let m = /\[demo-step\] (\S+) (\d+)/.exec(e.message);
        if (m) {
          markers.push({ kind: 'step', id: m[1], at: Number(m[2]) });
          console.log(`step ${m[1]}`);
          if (m[1] === 'end') endAt = Date.now();
        }
        m = /\[demo-say\] (.+)/.exec(e.message);
        if (m) markers.push({ kind: 'say', text: m[1], at: e.ts ?? at });
        m = /\[demo-voice\] (\S+) (\d+)/.exec(e.message);
        if (m) markers.push({ kind: 'voice', clip: m[1], at: Number(m[2]) });
        m = /\[demo-error\] (.+)/.exec(e.message);
        if (m) { markers.push({ kind: 'error', text: m[1] }); console.log(`ERROR ${m[1]}`); }
      }
    } catch {
      if (frames.length === 0) await sleep(800);
    }
    if (endAt && Date.now() - endAt > 1500) break;
    if (Date.now() > hardStop) { console.log('stopped: time limit reached'); break; }
    await sleep(90);
  }
  writeFileSync(join(OUT, 'capture.json'), JSON.stringify({ frames, markers }, null, 1));
  const steps = markers.filter((m) => m.kind === 'step');
  console.log(`captured ${frames.length} frames, ${steps.length} step markers, ${markers.filter((m) => m.kind === 'error').length} errors`);
  process.exit(steps.some((m) => m.id === 'end') ? 0 : 1);
}

// ---------------------------------------------------------------- compose
const W = 1920;
const H = 1080;
const GREEN = '0x3DFF7A';
const DIM = '0x1F8A42';
const FONT = (name) => `C\\:/Windows/Fonts/${name}`;

function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const w of text.split(/\s+/)) {
    if (line && line.length + 1 + w.length > width) { lines.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines;
}

function compose() {
  const { frames, markers } = JSON.parse(readFileSync(join(OUT, 'capture.json'), 'utf8'));
  const narration = JSON.parse(readFileSync('apps/glasses/src/demo/narration.json', 'utf8'));
  const durations = JSON.parse(readFileSync('apps/glasses/src/demo/durations.json', 'utf8'));
  const script = readFileSync('apps/glasses/src/demo/script.ts', 'utf8');
  const titles = Object.fromEntries([...script.matchAll(/step\('([\w-]+)', '([^']+)'/g)].map((m) => [m[1], m[2]]));
  const gestures = Object.fromEntries([...script.matchAll(/step\('([\w-]+)', '[^']+', \{ type: 'gesture', gesture: '(\w+)'/g)].map((m) => [m[1], m[2]]));
  const confirms = new Set([...script.matchAll(/step\('([\w-]+)', '[^']+', \{ type: 'confirm' \}/g)].map((m) => m[1]));
  const steps = markers.filter((m) => m.kind === 'step');
  const first = steps[0].at;
  const end = steps.find((s) => s.id === 'end')?.at ?? frames.at(-1).at;

  const intro = durations.title / 1000 + 0.5;
  const appStart = first - 200;
  const appLen = (end - appStart) / 1000 + 0.4;
  const howLen = durations.how / 1000 + 0.6;
  const whoLen = durations.who / 1000 + 0.6;
  const outro = durations.closing / 1000 + 1.2;
  const total = intro + appLen + howLen + whoLen + outro;
  const tl = (epoch) => intro + (epoch - appStart) / 1000; // app time -> video time

  // glasses frames as a variable-rate sequence
  const usable = frames.filter((f) => f.at >= appStart - 1500);
  const list = [];
  for (let i = 0; i < usable.length; i++) {
    const from = Math.max(usable[i].at, appStart);
    const to = i + 1 < usable.length ? Math.max(usable[i + 1].at, appStart) : end + 400;
    if (to <= from) continue;
    list.push(`file '${usable[i].name}'`, `duration ${((to - from) / 1000).toFixed(3)}`);
  }
  list.push(`file '${usable.at(-1).name}'`);
  writeFileSync(join(FRAMES, 'list.txt'), list.join('\n'));

  const textDir = join(OUT, 'text');
  rmSync(textDir, { recursive: true, force: true });
  mkdirSync(textDir, { recursive: true });
  let n = 0;
  const draws = [];
  /** One drawtext per line (centred), shown between a and b seconds. Text goes through files: no escaping traps. */
  const text = (content, { y, size, color = GREEN, font = 'segoeui.ttf', a = 0, b = total, x = '(w-text_w)/2' }) => {
    const file = `t${n++}.txt`;
    writeFileSync(join(textDir, file), content);
    draws.push(`drawtext=fontfile='${FONT(font)}':textfile='text/${file}':expansion=none:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}:enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'`);
  };

  // title card
  text('PULSE', { y: 300, size: 170, font: 'segoeuib.ttf', b: intro });
  text('Your financial world, at a glance.', { y: 510, size: 52, b: intro });
  text('A voice-first trading copilot for Even Realities G2', { y: 620, size: 34, color: DIM, b: intro });
  text('Heads Up Hackathon  |  Exchanges & Stocks  |  Binance Spot Testnet', { y: 680, size: 30, color: DIM, b: intro });

  // app segment: brand, step title, what the wearer says or does, subtitles
  const aEnd = intro + appLen;
  text('PULSE', { x: '70', y: 46, size: 44, font: 'segoeuib.ttf', a: intro, b: aEnd });
  text('BINANCE SPOT TESTNET  |  Even Hub simulator', { x: 'w-text_w-70', y: 58, size: 26, color: DIM, a: intro, b: aEnd });
  // Say plainly how the take was made.
  text('Demo autopilot: typed requests follow the same path as speech. The spoken request uses synthesized speech, transcribed live. AI voiceover.', { y: 1036, size: 22, color: DIM, a: intro, b: aEnd });
  const stepList = steps.filter((s) => s.id !== 'end');
  stepList.forEach((s, i) => {
    const a = i === 0 ? intro : tl(s.at);
    const b = i + 1 < stepList.length ? tl(stepList[i + 1].at) : aEnd;
    text(titles[s.id] ?? s.id, { y: 112, size: 48, font: 'segoeuib.ttf', a, b });
    const said = markers.find((m) => m.kind === 'say' && m.at >= s.at - 500 && (i + 1 >= stepList.length || m.at < stepList[i + 1].at));
    let act = '';
    if (s.id === 'again') act = 'End the session, then start a new one';
    else if (confirms.has(s.id)) act = 'Gesture: swipe, then tap';
    else if (gestures[s.id]) act = { swipe_down: 'Gesture: swipe', swipe_up: 'Gesture: swipe', click: 'Gesture: one tap', double_click: 'Gesture: double tap' }[gestures[s.id]];
    else if (s.id === 'voice') act = said ? `Spoken aloud, transcribed live:  "${said.text}"` : 'Spoken aloud';
    else if (said) act = `You say:  "${said.text}"`;
    else if (s.id === 'fired') act = 'No input: the plan fired';
    if (act) text(act, { y: 808, size: 38, a, b });
    wrap(narration[s.id] ?? '', 88).slice(0, 3).forEach((line, k) => text(line, { y: 890 + k * 48, size: 34, color: '0xD8FFE6', a, b }));
  });

  // how it works, then who it is for
  const card = (start, len, title, lines) => {
    text('PULSE', { x: '70', y: 46, size: 44, font: 'segoeuib.ttf', a: start, b: start + len });
    text(title, { y: 230, size: 76, font: 'segoeuib.ttf', a: start, b: start + len });
    lines.forEach((line, k) => text(line, { y: 420 + k * 90, size: 42, color: '0xD8FFE6', a: start + 0.3 + k * (len / (lines.length + 3)), b: start + len }));
  };
  card(aEnd, howLen, 'Under the hood', [
    'G2 glasses  ->  PULSE backend  ->  Binance Spot Testnet',
    'Approval is locked to the exact terms shown (SHA-256)',
    'Idempotent execution: an order is never sent twice',
    'The AI explains. It cannot approve or execute',
    'Neon memory and audit trail, covered by automated safety tests',
  ]);
  card(aEnd + howLen, whoLen, 'Who it is for', [
    'Active traders who cannot live inside a phone screen',
    'Glance, ask, plan ahead, approve with one tap',
    'One safety layer, designed for more exchanges behind one adapter',
  ]);

  // closing card
  const o = aEnd + howLen + whoLen;
  text('PULSE', { y: 190, size: 130, font: 'segoeuib.ttf', a: o });
  text('AI interprets.  The backend verifies.  You decide.  Binance executes.', { y: 400, size: 44, a: o });
  ['Buy, sell, plan and cancel by voice and tap, on a 576 x 288 lens', 'Real Binance Spot Testnet orders, approved one by one', 'On Binance testnet right now: no withdrawals, no margin, no autonomous trading'].forEach((line, k) =>
    text(line, { y: 520 + k * 70, size: 36, color: '0xD8FFE6', a: o + 0.4 }));
  text('Your financial world, at a glance.', { y: 820, size: 40, color: DIM, a: o });

  // lens: 576x288 scaled x2 with a thin frame
  const lw = 1152;
  const lh = 576;
  const lx = (W - lw) / 2;
  const ly = 200;
  const graph = [
    `color=c=0x030806:s=${W}x${H}:r=30:d=${total.toFixed(3)}[bg]`,
    `[0:v]format=rgba,scale=${lw}:${lh}:flags=lanczos,fps=30,setpts=PTS-STARTPTS+${intro.toFixed(3)}/TB[lens]`,
    `[bg]drawbox=x=${lx - 14}:y=${ly - 14}:w=${lw + 28}:h=${lh + 28}:color=${DIM}@0.9:t=3:enable='between(t,${intro.toFixed(3)},${aEnd.toFixed(3)})',drawbox=x=${lx - 11}:y=${ly - 11}:w=${lw + 22}:h=${lh + 22}:color=black:t=fill:enable='between(t,${intro.toFixed(3)},${aEnd.toFixed(3)})'[stage]`,
    `[stage][lens]overlay=${lx}:${ly}:eof_action=pass:enable='between(t,${intro.toFixed(3)},${aEnd.toFixed(3)})'[shot]`,
    `[shot]${draws.join(',')},fade=t=in:st=0:d=0.5,fade=t=out:st=${(total - 0.8).toFixed(3)}:d=0.8,format=yuv420p[v]`,
  ];

  // voiceover: one delayed clip per line
  const clips = [{ id: 'title', t: 0.35 }, ...stepList.map((s, i) => ({ id: s.id, t: (i === 0 ? intro : tl(s.at)) + 0.15 })), { id: 'how', t: aEnd + 0.35 }, { id: 'who', t: aEnd + howLen + 0.35 }, { id: 'closing', t: aEnd + howLen + whoLen + 0.4 }];
  // The wearer's own spoken requests, placed where the app heard them.
  const spoken = markers.filter((m) => m.kind === 'voice').map((m) => ({ file: resolve('apps/glasses/public/demo', `${m.clip}.wav`), t: tl(m.at) + 0.05 }));
  const sounds = [...clips.map((c) => ({ file: resolve(OUT, 'voice', `${c.id}.wav`), t: c.t })), ...spoken];
  const audioInputs = sounds.flatMap((c) => ['-i', c.file]);
  sounds.forEach((c, i) => graph.push(`[${i + 1}:a]aresample=48000,adelay=${Math.round(c.t * 1000)}:all=1[a${i}]`));
  graph.push(`${sounds.map((_, i) => `[a${i}]`).join('')}amix=inputs=${sounds.length}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11,apad,atrim=0:${total.toFixed(3)}[a]`);

  // report any narration that would run into the next one
  clips.forEach((c, i) => {
    const next = clips[i + 1];
    if (next && c.t + durations[c.id] / 1000 > next.t + 0.05) console.log(`warning: voice "${c.id}" overlaps "${next.id}" by ${(c.t + durations[c.id] / 1000 - next.t).toFixed(2)}s`);
  });

  writeFileSync(join(OUT, 'graph.txt'), graph.join(';\n'));
  const final = join(OUT, 'pulse-demo.mp4');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'frames/list.txt', ...audioInputs,
    '-/filter_complex', 'graph.txt', '-map', '[v]', '-map', '[a]', '-t', total.toFixed(3), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', final],
  { cwd: OUT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log(`wrote ${final}  (${total.toFixed(1)} s: title ${intro.toFixed(1)} + app ${appLen.toFixed(1)} + closing ${outro.toFixed(1)})`);
  if (total > 180) console.log('WARNING: longer than the 3-minute limit');
}

if (cmd === 'capture') await capture();
else if (cmd === 'compose') compose();
else { console.log('usage: capture | compose'); process.exit(2); }
