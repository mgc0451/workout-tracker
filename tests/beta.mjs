import { chromium, devices } from './_playwright.mjs';

const ROOT = (process.env.APP_URL || 'http://localhost:8199/index.html').replace(/index\.html$/, '');
let pass = 0, fail = 0;
const ok = (name, condition, extra = '') => condition
  ? (pass++, console.log(`  PASS  ${name}`))
  : (fail++, console.log(`  FAIL  ${name}  ${extra}`));
const browser = await chromium.launch();
const context = await browser.newContext({ ...devices['iPhone 13'] });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));

console.log('\n── Classic / Beta isolation ──');
await page.goto(`${ROOT}index.html`);
ok('Classic exposes an opt-in Beta link', await page.getByRole('link', { name: /Open the Beta/ }).getAttribute('href') === 'beta/');
ok('Classic still renders its original home', await page.getByText('Workout Tracker', { exact: true }).isVisible());

await page.goto(`${ROOT}beta/`);
ok('Beta loads without runtime errors', errors.length === 0, errors.join('; '));
ok('Beta identifies the Command Center', await page.getByText('Command center').isVisible());
ok('Beta offers a Classic return link', await page.getByRole('link', { name: /Classic/ }).getAttribute('href') === '../');
ok('Beta has Today, Train and Insights navigation', await page.locator('.beta-bottom-nav button').count() === 3);
ok('Beta uses the shared workouts key', await page.evaluate(() => localStorage.getItem('workouts') !== null));

console.log('\n── Shared session handoff ──');
await page.getByRole('button', { name: /Start training/i }).click();
ok('Beta starts the suggested workout', await page.locator('.exercise-item').count() > 0);
await page.locator('.exercise-item').first().click();
await page.locator('#repsInput').fill('8');
await page.locator('#btnLogSet').click();
ok('Beta persists progress only after the first logged set', await page.evaluate(() => {
  const session = JSON.parse(localStorage.getItem('currentSession'));
  return session?.exercises?.[0]?.sets?.length === 1;
}));
await page.goto(`${ROOT}index.html`);
ok('Classic can see the Beta-started session state', await page.evaluate(() => JSON.parse(localStorage.getItem('currentSession'))?.sessionType != null));

console.log('\n── Beta assets ──');
const manifest = await (await page.request.get(`${ROOT}beta/manifest.webmanifest`)).json();
ok('Beta manifest is independently scoped', manifest.start_url === '.' && manifest.scope === '.');
const sw = await (await page.request.get(`${ROOT}sw.js`)).text();
ok('Root worker precaches the Beta shell', sw.includes("'./beta/index.html'") && sw.includes("'./beta/beta.css'"));
ok('Root worker has a Beta-specific offline fallback', sw.includes("url.pathname.includes('/beta/')"));

await context.close();
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
