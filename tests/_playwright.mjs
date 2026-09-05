// Resolve Playwright from wherever it happens to live.
// Tries a local install first, then a global one, then PLAYWRIGHT_PATH.
import { createRequire } from 'module';
import { execSync } from 'child_process';

const require = createRequire(import.meta.url);

const candidates = [
  process.env.PLAYWRIGHT_PATH,
  'playwright',
  '@playwright/test',
];

// A global install is not on Node's resolution path, so ask npm where it is.
try {
  const globalRoot = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (globalRoot) candidates.push(`${globalRoot}/playwright`, `${globalRoot}/@playwright/test`);
} catch { /* npm not available — the other candidates may still work */ }

let pw = null;
for (const c of candidates.filter(Boolean)) {
  try { pw = require(c); break; } catch { /* try the next one */ }
}

if (!pw || !pw.chromium) {
  throw new Error(
    'Playwright not found. Install it with `npm i -D playwright` (then `npx playwright install chromium`), ' +
    'or point PLAYWRIGHT_PATH at an existing install.'
  );
}

export const { chromium, devices } = pw;
