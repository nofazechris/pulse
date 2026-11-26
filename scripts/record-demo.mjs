// Records the Even Hub simulator for the demo video, silently, using ffmpeg.
// It captures ONLY the two simulator windows' screen rectangles (never the rest of the desktop), then joins them side by side.
// The simulator windows must be on top while recording (see docs/DEMO_SCRIPT.md), otherwise whatever covers them is recorded.
//
//   node scripts/record-demo.mjs capture --panel x,y,w,h --glasses x,y,w,h [--seconds 200] [--out demo-video]
//   node scripts/record-demo.mjs compose --trim <seconds> [--length <seconds>] [--out demo-video]
//
// Requires ffmpeg on PATH (winget install Gyan.FFmpeg). Output: demo-video/pulse-demo.mp4 (git-ignored).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cmd = 'capture', ...rest] = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : dflt;
};
const out = arg('out', 'demo-video');
mkdirSync(out, { recursive: true });
const rect = (name) => {
  const v = (arg(name, '') || '').split(',').map(Number);
  if (v.length !== 4 || v.some((n) => !Number.isFinite(n))) { console.error(`--${name} x,y,w,h is required`); process.exit(2); }
  return v;
};
const WINDOWS = [
  { name: 'panel', file: 'panel.mkv' }, // the app panel with the on-screen captions
  { name: 'glasses', file: 'glasses.mkv' }, // what the wearer sees
];
const logFile = join(out, 'capture-log.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

function startCapture(w, seconds) {
  const [x, y, cw, ch] = rect(w.name);
  const args = ['-y', '-loglevel', 'error', '-f', 'gdigrab', '-framerate', '20', '-draw_mouse', '0', '-offset_x', String(x), '-offset_y', String(y),
    '-video_size', `${cw - (cw % 2)}x${ch - (ch % 2)}`, '-i', 'desktop', '-t', String(seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', join(out, w.file)];
  const startedAt = Date.now();
  const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  p.stderr.on('data', (d) => console.log(`[${w.name}] ${String(d).trim()}`));
  return { p, startedAt, done: new Promise((res) => p.on('exit', res)) };
}

if (cmd === 'capture') {
  const seconds = Number(arg('seconds', 200));
  const starts = WINDOWS.map((w) => startCapture(w, seconds));
  const log = { startedAt: Object.fromEntries(starts.map((s, i) => [WINDOWS[i].file, s.startedAt])), seconds };
  writeFileSync(logFile, JSON.stringify(log, null, 2));
  console.log(`Recording both windows for up to ${seconds}s (silent) into ${out}/`);
  const codes = await Promise.all(starts.map((s) => s.done));
  console.log(codes.every((c) => c === 0) ? 'Capture finished.' : `Capture ended with exit codes ${codes.join(',')}`);
} else if (cmd === 'compose') {
  const trim = Number(arg('trim', 0));
  const log = JSON.parse(readFileSync(logFile, 'utf8'));
  // The two captures started a moment apart; align them on the later one.
  const t0 = Math.max(...Object.values(log.startedAt));
  const skew = (f) => (t0 - log.startedAt[f]) / 1000 + trim;
  const final = join(out, 'pulse-demo.mp4');
  const length = arg('length', '');
  const H = 840;
  const filter = `[0:v]scale=-2:${H}[a];[1:v]pad=iw:${H}:0:0:black[b];[a][b]hstack=inputs=2,pad=ceil(iw/2)*2:ceil(ih/2)*2[v]`;
  const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', String(skew('panel.mkv')), '-i', join(out, 'panel.mkv'), '-ss', String(skew('glasses.mkv')), '-i', join(out, 'glasses.mkv'),
    '-filter_complex', filter, '-map', '[v]', ...(length ? ['-t', length] : []), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', final], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log(`Wrote ${final}`);
} else {
  console.log('usage: capture | compose');
  process.exit(2);
}
