// Builds the glasses app and packages it as pulse.ehpk.
//   npm run pack:ehpk                                   local backend (http://localhost:8787, simulator use)
//   npm run pack:ehpk -- --api https://your.host        hosted backend: bakes in the URL and whitelists it
// Before packaging, the built files are checked for every secret in apps/api/.env (values are never printed).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const i = process.argv.indexOf('--api');
const raw = i >= 0 ? process.argv[i + 1] : 'http://localhost:8787';
let api;
try {
  api = new URL(raw ?? '');
} catch {
  console.error('--api needs a full URL, for example https://pulse-api.onrender.com');
  process.exit(2);
}
const local = ['localhost', '127.0.0.1'].includes(api.hostname);
if (api.protocol !== 'https:' && !local) {
  console.error('A hosted backend must use https.');
  process.exit(2);
}

const run = (cmd, env = {}) => {
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run('npm run build -w @pulse/glasses', { VITE_API_URL: api.origin });

const dist = 'apps/glasses/dist';
const files = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : [join(d, n)]));
if (existsSync('apps/api/.env')) {
  const secrets = readFileSync('apps/api/.env', 'utf8').split(/\r?\n/)
    .map((l) => /^(DATABASE_URL|DATABASE_DIRECT_URL|BINANCE_API_KEY|BINANCE_API_SECRET|AI_API_KEY|STT_API_KEY|SESSION_SECRET|PAIRING_CODE)=(.+)$/.exec(l))
    .filter(Boolean).map((m) => [m[1], m[2].trim().replace(/^"|"$/g, '')]).filter(([, v]) => v.length >= 8);
  for (const f of files(dist)) {
    const text = readFileSync(f, 'latin1');
    for (const [name, value] of secrets) {
      if (text.includes(value)) { console.error(`REFUSING to package: ${name} is inside ${f}`); process.exit(1); }
    }
  }
  console.log(`secret check: ${files(dist).length} built files, ${secrets.length} secrets, none found`);
}

const manifest = JSON.parse(readFileSync('apps/glasses/app.json', 'utf8'));
manifest.permissions.find((p) => p.name === 'network').whitelist = [api.origin];
const tmp = 'apps/glasses/app.pack.json';
writeFileSync(tmp, JSON.stringify(manifest, null, 2));
const r = spawnSync(`npx evenhub pack ${tmp} ${dist} -o pulse.ehpk`, { shell: true, stdio: 'inherit' });
rmSync(tmp, { force: true });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`pulse.ehpk (${(statSync('pulse.ehpk').size / 1024).toFixed(0)} KB) talks to ${api.origin}${local ? '  (without a local backend it offers the labelled practice mode)' : ''}`);
