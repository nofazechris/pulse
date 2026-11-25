// Starts the API and the glasses dev server together (cross-platform, no extra dependency).
import { spawn } from 'node:child_process';

const procs = [
  ['api', 'npm', ['run', 'dev', '-w', '@pulse/api']],
  ['glasses', 'npm', ['run', 'dev', '-w', '@pulse/glasses']],
].map(([name, cmd, args]) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const tag = (s) => s.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`));
  p.stdout.on('data', tag);
  p.stderr.on('data', tag);
  p.on('exit', (code) => { console.log(`[${name}] exited (${code})`); shutdown(); });
  return p;
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  for (const p of procs) { try { p.kill(); } catch { /* already gone */ } }
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
