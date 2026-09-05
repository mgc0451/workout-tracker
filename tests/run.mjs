#!/usr/bin/env node
// Runs every suite in this directory against a throwaway static server.
//
//   node tests/run.mjs            # all suites
//   node tests/run.mjs sync pwa   # only the named ones
//
// Each suite is a standalone script that exits non-zero on failure, so they
// can also be run individually:  APP_URL=... node tests/sync.mjs
import { spawn, execSync } from 'child_process';
import { readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const PORT = process.env.PORT || 8199;
const URL  = `http://localhost:${PORT}/index.html`;

// Suite order is roughly oldest-feature-first, so a failure early on points at
// a foundational regression rather than a new feature.
const ORDER = ['wpb', 'wpa', 'bugsad', 'review', 'pwa', 'wp3', 'newfeat', 'sync', 'resttimer'];
const available = readdirSync(HERE)
  .filter(f => f.endsWith('.mjs') && !f.startsWith('_') && f !== 'run.mjs')
  .map(f => f.replace(/\.mjs$/, ''));

const requested = process.argv.slice(2);
const suites = (requested.length ? requested : [...ORDER, ...available.filter(s => !ORDER.includes(s))])
  .filter(s => available.includes(s));

if (!suites.length) {
  console.error(`No suites to run. Available: ${available.join(', ')}`);
  process.exit(1);
}

const run = (cmd, args, opts = {}) => new Promise(res => {
  const p = spawn(cmd, args, { ...opts });
  let out = '';
  p.stdout?.on('data', d => (out += d));
  p.stderr?.on('data', d => (out += d));
  p.on('close', code => res({ code, out }));
});

// Serve the repo. python3 is used because it needs no dependencies.
const server = spawn('python3', ['-m', 'http.server', String(PORT)], {
  cwd: REPO, stdio: 'ignore', detached: true,
});
const stop = () => { try { process.kill(-server.pid); } catch {} };
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

// Wait for it to answer rather than sleeping a fixed amount.
let up = false;
for (let i = 0; i < 40; i++) {
  try {
    execSync(`curl -sf -o /dev/null ${URL}`, { stdio: 'ignore' });
    up = true; break;
  } catch { await new Promise(r => setTimeout(r, 250)); }
}
if (!up) { console.error(`Server never came up on ${URL}`); stop(); process.exit(1); }

let totalPass = 0, totalFail = 0;
const failed = [];

for (const s of suites) {
  const { code, out } = await run(process.execPath, [join(HERE, `${s}.mjs`)], {
    env: { ...process.env, APP_URL: URL },
  });
  const m = out.match(/(\d+) passed, (\d+) failed/);
  const p = m ? +m[1] : 0, f = m ? +m[2] : 0;
  totalPass += p; totalFail += f;
  const status = code === 0 && f === 0 ? 'PASS' : 'FAIL';
  if (status === 'FAIL') { failed.push(s); }
  console.log(`${status.padEnd(4)}  ${s.padEnd(10)} ${m ? `${p} passed, ${f} failed` : '(no result line)'}`);
  if (status === 'FAIL') console.log(out.split('\n').filter(l => /FAIL|ERROR/.test(l)).map(l => '        ' + l).join('\n'));
}

stop();
console.log(`\n${failed.length ? 'FAILURES in: ' + failed.join(', ') : 'ALL SUITES PASS'} — ${totalPass} passed, ${totalFail} failed`);
process.exit(failed.length ? 1 : 0);
