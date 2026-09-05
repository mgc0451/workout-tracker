// Contract tests for the offline-safe Sheets sync queue (WP-4).
// Contract, fixed up front so the implementation is written against it:
//   localStorage key 'syncQueue' holds an array of batches:
//     [{ id: <unique string>, entries: [<history entry>, ...], queuedAt: <ISO> }]
//   - completeSession ALWAYS enqueues, then attempts a drain.
//   - A batch is removed from the queue only after its POST resolves.
//   - drainSyncQueue() is idempotent and safe to call concurrently.
//   - It runs on load and on the window 'online' event.
//   - A failed POST leaves the batch queued; it must not be lost or duplicated.
//   - Sheets payload shape per batch is unchanged: entries with exactly
//     date, exercise, session, sets.
import { chromium, devices } from './_playwright.mjs';

const URL = process.env.APP_URL || 'http://localhost:8199/index.html';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${extra}`)); };
const browser = await chromium.launch();

async function fresh({ offline = false, failSync = false } = {}) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const posts = [];
  page.on('pageerror', e => { fail++; console.log('  PAGE ERROR:', e.message); });
  await page.route('**/script.google.com/**', route => {
    posts.push(route.request().postData());
    if (failSync) return route.abort('failed');
    route.fulfill({ status: 200, body: '{}' });
  });
  await page.goto(URL);
  await page.waitForTimeout(400);
  if (offline) await ctx.setOffline(true);
  return { ctx, page, posts };
}

// Log one full exercise and complete the session, all through the app's own API.
const logAndComplete = `(() => {
  const w = state.workouts[0];
  startSession(w.id);
  selectExercise(0);
  state.weight = 60; state.repInput = '8';
  addSet(); addSet(); addSet();
  completeExercise();
  completeSession();
})()`;

console.log('\n── Queue drains when the sync succeeds ──');
{
  const { ctx, page, posts } = await fresh();
  await page.evaluate(logAndComplete);
  await page.waitForTimeout(900);
  ok('a POST was attempted', posts.length >= 1, `posts=${posts.length}`);
  const q = await page.evaluate(() => JSON.parse(localStorage.getItem('syncQueue') || '[]'));
  ok('queue is empty after a successful send', q.length === 0, JSON.stringify(q).slice(0, 160));
  if (posts[0]) {
    const body = JSON.parse(posts[0]);
    const keys = Object.keys(body[0]).sort().join(',');
    ok('payload shape unchanged (date,exercise,session,sets)', keys === 'date,exercise,session,sets', keys);
  }
  ok('history written regardless of sync', (await page.evaluate(() => state.history.length)) > 0);
  await ctx.close();
}

console.log('\n── A failed sync keeps the batch queued ──');
{
  const { ctx, page } = await fresh({ failSync: true });
  await page.evaluate(logAndComplete);
  await page.waitForTimeout(900);
  const q = await page.evaluate(() => JSON.parse(localStorage.getItem('syncQueue') || '[]'));
  ok('batch retained after a failed send', q.length === 1, JSON.stringify(q).slice(0, 160));
  ok('queued batch carries the entries', q[0]?.entries?.length > 0, JSON.stringify(q[0] || {}).slice(0, 160));
  ok('queued batch has an id', typeof q[0]?.id === 'string' && q[0].id.length > 0);
  ok('session still completed locally', (await page.evaluate(() => state.activeSession)) === null);
  ok('history still saved while sync failed', (await page.evaluate(() => state.history.length)) > 0);
  await ctx.close();
}

console.log('\n── Queue survives reload and drains on next load ──');
{
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => { fail++; console.log('  PAGE ERROR:', e.message); });
  let failing = true;
  const posts = [];
  await page.route('**/script.google.com/**', route => {
    posts.push(route.request().postData());
    if (failing) return route.abort('failed');
    route.fulfill({ status: 200, body: '{}' });
  });
  await page.goto(URL);
  await page.waitForTimeout(400);
  await page.evaluate(logAndComplete);
  await page.waitForTimeout(900);
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('syncQueue') || '[]').length);
  ok('queued while offline/failing', before === 1, String(before));

  failing = false;                       // "back online"
  await page.reload();
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('syncQueue') || '[]').length);
  ok('drained automatically on next load', after === 0, String(after));
  ok('no duplicate entries sent', posts.length >= 2, `posts=${posts.length}`);
  await ctx.close();
}

console.log('\n── Draining twice does not double-send ──');
{
  const { ctx, page, posts } = await fresh({ failSync: false });
  await page.evaluate(() => localStorage.setItem('syncQueue', JSON.stringify([
    { id: 'batch-1', queuedAt: '2026-09-01T00:00:00.000Z',
      entries: [{ date: '2026-09-01T00:00:00.000Z', exercise: 'Deadlift', session: 'B', sets: [{ weight: 100, reps: 5 }] }] },
  ])));
  await page.evaluate(() => { drainSyncQueue(); drainSyncQueue(); });
  await page.waitForTimeout(1200);
  const q = await page.evaluate(() => JSON.parse(localStorage.getItem('syncQueue') || '[]'));
  ok('queue emptied', q.length === 0, JSON.stringify(q).slice(0, 120));
  const deadliftPosts = posts.filter(p => p && p.includes('Deadlift')).length;
  ok('batch sent exactly once despite two drain calls', deadliftPosts === 1, `sends=${deadliftPosts}`);
  await ctx.close();
}

console.log('\n── Corrupt queue does not brick startup ──');
{
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.route('**/script.google.com/**', r => r.fulfill({ status: 200, body: '{}' }));
  await page.goto(URL);
  await page.evaluate(() => localStorage.setItem('syncQueue', '{"not":"an array"}'));
  await page.goto(URL);
  await page.waitForTimeout(800);
  ok('app boots with a corrupt queue', (await page.evaluate(() => document.getElementById('app').innerHTML.length)) > 0);
  ok('no page errors from the corrupt queue', errs.length === 0, errs.join('; '));
  await ctx.close();
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
