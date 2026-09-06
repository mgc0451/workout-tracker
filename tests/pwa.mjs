import { chromium, devices } from './_playwright.mjs';

const URL = process.env.APP_URL || 'http://localhost:8199/index.html';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${extra}`)); };
const browser = await chromium.launch();

console.log('\n── Manifest + meta ──');
{
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(URL);
  const meta = await page.evaluate(() => ({
    manifest: document.querySelector('link[rel=manifest]')?.getAttribute('href'),
    theme: document.querySelector('meta[name=theme-color]')?.content,
    appleCapable: document.querySelector('meta[name=apple-mobile-web-app-capable]')?.content,
    touchIcon: document.querySelector('link[rel=apple-touch-icon]')?.getAttribute('href'),
    viewport: document.querySelector('meta[name=viewport]')?.content,
  }));
  ok('manifest linked relatively', meta.manifest === 'manifest.webmanifest', String(meta.manifest));
  ok('theme-color set', meta.theme === '#070c16', String(meta.theme));
  ok('apple web-app capable', meta.appleCapable === 'yes');
  ok('apple touch icon relative', meta.touchIcon === 'icon-192.png', String(meta.touchIcon));
  ok('viewport-fit=cover present', /viewport-fit=cover/.test(meta.viewport), meta.viewport);
  ok('pinch-zoom no longer blocked', !/user-scalable=no|maximum-scale/.test(meta.viewport), meta.viewport);
  const m = await (await page.request.get('http://localhost:8199/manifest.webmanifest')).json();
  ok('start_url + scope are relative (project-page safe)', m.start_url === '.' && m.scope === '.', `${m.start_url} / ${m.scope}`);
  ok('display standalone', m.display === 'standalone');
  ok('has a maskable icon', m.icons.some(i => /maskable/.test(i.purpose || '')));
  ok('no page errors', errs.length === 0, errs.join('; '));

  // Focus-zoom lock: text/number fields pin maximum-scale while focused so iOS
  // won't zoom in when the keyboard opens, then release it on blur so pinch-zoom
  // returns. Non-keyboard controls (select, date pickers) must NOT be locked.
  // This guards the JS mechanism; the actual iOS zoom-prevention needs a real
  // device — Chromium emulation can't model WebKit's focus-zoom.
  const zoomLock = await page.evaluate(() => {
    const meta = document.querySelector('meta[name=viewport]');
    const read = () => meta.getAttribute('content');
    const num = document.createElement('input'); num.type = 'number';
    document.body.appendChild(num);
    num.focus();       const numFocused = read();
    num.blur();        const numBlurred = read();
    num.remove();
    const sel = document.createElement('select'); document.body.appendChild(sel);
    sel.focus();       const selFocused = read();
    sel.blur(); sel.remove();
    return { numFocused, numBlurred, selFocused };
  });
  ok('focus-zoom lock pins maximum-scale on number-field focus', /maximum-scale=1/.test(zoomLock.numFocused), zoomLock.numFocused);
  ok('focus-zoom lock releases on blur (pinch-zoom returns)', !/maximum-scale/.test(zoomLock.numBlurred), zoomLock.numBlurred);
  ok('focus-zoom lock ignores non-keyboard controls (select)', !/maximum-scale/.test(zoomLock.selFocused), zoomLock.selFocused);
  await ctx.close();
}

console.log('\n── Service worker + offline ──');
{
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(URL);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null || navigator.serviceWorker.getRegistration().then(r => !!r), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const reg = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return r ? (r.active ? 'active' : 'registered') : 'none'; });
  ok('service worker registered', reg !== 'none', reg);
  await page.reload();
  await page.waitForTimeout(1500);
  const keys = await page.evaluate(() => caches.keys());
  ok('versioned cache exists', keys.includes('workout-tracker-v1'), JSON.stringify(keys));
  const cachedIdx = await page.evaluate(async () => {
    const c = await caches.open('workout-tracker-v1');
    const r = await c.match('./index.html') || await c.match(location.href);
    return !!r;
  });
  ok('index.html is in the cache', cachedIdx);

  // The real test: go offline and reload.
  await ctx.setOffline(true);
  await page.reload().catch(() => {});
  await page.waitForTimeout(1200);
  const offlineBody = await page.evaluate(() => document.getElementById('app')?.innerText || '');
  ok('app renders while OFFLINE', /START WORKOUT|Workout Tracker|No workouts/i.test(offlineBody) || offlineBody.length > 100,
    JSON.stringify(offlineBody.slice(0, 120)));
  const offlineWorks = await page.evaluate(() => typeof state === 'object' && Array.isArray(state.workouts));
  ok('app state initialised while offline', offlineWorks);
  await ctx.setOffline(false);
  ok('no page errors across the SW lifecycle', errs.length === 0, errs.join('; '));
  await ctx.close();
}

// NOTE: update propagation is covered by update.mjs, not here. A page.route
// handler cannot intercept a service-worker-originated fetch, so testing it
// from inside this suite silently measures nothing. update.mjs instead edits
// a real file on a real server -- the same path a Pages deploy takes -- and
// asserts the new build is served and the offline cache refreshes to it.

console.log('\n── App still works with the SW active ──');
{
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(URL);
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /START WORKOUT/i }).click();
  await page.getByRole('button', { name: /Session B/ }).first().click();
  await page.getByRole('button', { name: /Deadlift/ }).first().click();
  await page.waitForSelector('#weightInput');
  await page.locator('#weightInput').fill('100');
  await page.locator('#repsInput').fill('5');
  await page.locator('#btnLogSet').click();
  ok('can log a set with the SW active', /100kg × 5/.test(await page.locator('.set-row').first().textContent()),
    (await page.locator('.set-row').first().textContent()).trim());
  ok('no page errors during a workout', errs.length === 0, errs.join('; '));
  await ctx.close();
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
