// Generates the demo voiceover (one clip per narration line) with OpenAI text-to-speech, using the key in
// apps/api/.env (never printed). Writes clips to demo-video/voice/ and their lengths to
// apps/glasses/src/demo/durations.json, which the demo autopilot uses to pace each step.
//   node scripts/make-voiceover.mjs [--voice cedar] [--only id,id]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const voice = arg('voice', 'cedar');
const only = arg('only', '')?.split(',').filter(Boolean);
const env = Object.fromEntries(readFileSync('apps/api/.env', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
if (!env.AI_API_KEY) { console.error('AI_API_KEY is not set in apps/api/.env'); process.exit(2); }

const lines = JSON.parse(readFileSync('apps/glasses/src/demo/narration.json', 'utf8'));
const outDir = 'demo-video/voice';
mkdirSync(outDir, { recursive: true });
const durFile = 'apps/glasses/src/demo/durations.json';
const durations = existsSync(durFile) ? JSON.parse(readFileSync(durFile, 'utf8')) : {};

const instructions =
  'You are narrating a short product story for hackathon judges. Warm, natural, confident and unhurried, like a person telling a story, not an advertisement. ' +
  'Brief natural pauses at commas and full stops. Pronounce "Pulse" as the word pulse, "testnet" as test-net, and "Binance" as BY-nance.';

// What the "wearer" says aloud in the voice step. A different voice from the narrator; the app transcribes this
// audio with the real speech-to-text service during the demo.
const WEARER = { 'wearer-btc': 'How is Bitcoin doing?' };
const wearerDir = 'apps/glasses/public/demo';
mkdirSync(wearerDir, { recursive: true });
for (const [id, text] of Object.entries(WEARER)) {
  if (only?.length && !only.includes(id)) continue;
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.AI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'marin', input: text, instructions: 'A person casually asking their glasses a question. Clear, natural, relaxed.', response_format: 'wav' }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) { console.error(`${id}: HTTP ${res.status}`); process.exit(1); }
  const raw = `${outDir}/${id}.raw`;
  writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
  // 16 kHz, 16-bit, mono: the same format the G2 microphone delivers.
  const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-fflags', '+bitexact', `${wearerDir}/${id}.wav`], { stdio: 'inherit' });
  if (ff.status !== 0) process.exit(1);
  console.log(`${id}: wearer clip written`);
}

for (const [id, text] of Object.entries(lines)) {
  const file = `${outDir}/${id}.wav`;
  if (only?.length && !only.includes(id)) continue;
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.AI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text, instructions, response_format: 'wav' }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    console.error(`${id}: HTTP ${res.status} ${(await res.text()).replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***').slice(0, 200)}`);
    process.exit(1);
  }
  writeFileSync(`${file}.raw`, Buffer.from(await res.arrayBuffer()));
  // Re-write through ffmpeg: trims leading/trailing silence and gives a correct WAV header.
  const trim = 'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse';
  const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${file}.raw`, '-af', trim, '-ar', '48000', '-ac', '1', file], { stdio: 'inherit' });
  if (ff.status !== 0) process.exit(1);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  durations[id] = Math.round(Number(probe.stdout.trim()) * 1000);
  console.log(`${id.padEnd(12)} ${(durations[id] / 1000).toFixed(1)} s`);
}
writeFileSync(durFile, `${JSON.stringify(durations, null, 2)}\n`);
console.log(`total speech: ${(Object.values(durations).reduce((a, b) => a + b, 0) / 1000).toFixed(1)} s  (voice: ${voice})`);
