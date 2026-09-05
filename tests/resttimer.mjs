// Ad-hoc Playwright checks for the rest timer feature.
import { chromium, devices } from './_playwright.mjs';

const URL = process.env.APP_URL || 'http://localhost:8199/index.html';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${extra}`)); };
const browser = await chromium.launch();

async function fresh() {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => { fail++; console.log('  PAGE ERROR:', e.message); });
  await page.route('**/script.google.com/**', route => route.fulfill({ status: 200, body: '{}' }));
  await page.goto(URL);
  await page.waitForTimeout(300);
  return { ctx, page };
}

console.log('\n── Rest timer auto-starts when a set is logged ──');
{
  const { ctx, page } = await fresh();
  await page.evaluate(() => {
    const w = state.workouts[0];
    startSession(w.id);
    selectExercise(0);
  });
  const beforeEndsAt = await page.evaluate(() => state.restEndsAt);
  ok('no countdown before any set is logged', beforeEndsAt === null, String(beforeEndsAt));
  await page.evaluate(() => { state.weight = 60; state.repInput = '8'; addSet(); });
  const afterEndsAt = await page.evaluate(() => state.restEndsAt);
  ok('restEndsAt set automatically after logging a set (no separate tap)', typeof afterEndsAt === 'number' && afterEndsAt > Date.now());
  const visible = await page.locator('#restTimerValue').isVisible().catch(() => false);
  ok('countdown widget is visible on screen', visible);
  await ctx.close();
}

console.log('\n── "1.5-2 min" rest parses to 90s (lower bound, decimals handled) ──');
{
  const { ctx, page } = await fresh();
  const secs = await page.evaluate(() => parseRestSeconds('1.5-2 min'));
  ok('"1.5-2 min" -> 90s', secs === 90, String(secs));
  const secs2 = await page.evaluate(() => parseRestSeconds('3-4 min'));
  ok('"3-4 min" -> 180s (lower bound)', secs2 === 180, String(secs2));
  const secs3 = await page.evaluate(() => parseRestSeconds('2 min'));
  ok('"2 min" -> 120s', secs3 === 120, String(secs3));
  await ctx.close();
}

console.log('\n── Unparseable rest string never produces NaN on screen ──');
{
  const { ctx, page } = await fresh();
  const secs = await page.evaluate(() => parseRestSeconds('banana'));
  ok('unparseable string falls back to a sensible default (90s), not NaN', secs === 90, String(secs));
  const secsEmpty = await page.evaluate(() => parseRestSeconds(''));
  ok('empty string falls back to default, not NaN', secsEmpty === 90, String(secsEmpty));
  const secsUndef = await page.evaluate(() => parseRestSeconds(undefined));
  ok('undefined falls back to default, not NaN', secsUndef === 90, String(secsUndef));

  await page.evaluate(() => {
    const w = state.workouts[0];
    startSession(w.id);
    selectExercise(0);
    state.activeExercise.rest = 'banana'; // force an unparseable rest string
    state.weight = 60; state.repInput = '8';
    addSet();
  });
  const text = await page.locator('#restTimerValue').textContent();
  ok('on-screen countdown has no NaN', !/NaN/.test(text), text);
  ok('on-screen countdown looks like mm:ss', /^\d{2}:\d{2}$/.test(text), text);
  await ctx.close();
}

console.log('\n── Countdown keeps decrementing across a setState-triggered re-render ──');
{
  const { ctx, page } = await fresh();
  await page.evaluate(() => {
    const w = state.workouts[0];
    startSession(w.id);
    selectExercise(0);
    state.activeExercise.rest = '2 min';
    state.weight = 60; state.repInput = '8';
    addSet();
  });
  const t1 = await page.locator('#restTimerValue').textContent();
  await page.waitForTimeout(2200);
  const t2 = await page.locator('#restTimerValue').textContent();
  ok('countdown text changed after ~2s of real time', t1 !== t2, `${t1} -> ${t2}`);

  // Trigger an unrelated full re-render via setState (editing a set, which
  // goes through setState -> render(), replacing app.innerHTML wholesale)
  // and confirm the countdown survived it and kept ticking rather than
  // resetting or vanishing.
  const beforeRestEndsAt = await page.evaluate(() => state.restEndsAt);
  await page.evaluate(() => setState({ editingSetIdx: 0 })); // arbitrary unrelated setState call
  await page.evaluate(() => setState({ editingSetIdx: null }));
  const afterRestEndsAt = await page.evaluate(() => state.restEndsAt);
  ok('restEndsAt (the target timestamp) is untouched by an unrelated re-render', beforeRestEndsAt === afterRestEndsAt);
  await page.waitForTimeout(1200);
  const t3 = await page.locator('#restTimerValue').textContent();
  ok('countdown is still ticking after the re-render', t3 !== t2 && /^\d{2}:\d{2}$/.test(t3), `${t2} -> ${t3}`);
  await ctx.close();
}

console.log('\n── +30s and skip controls work ──');
{
  const { ctx, page } = await fresh();
  await page.evaluate(() => {
    const w = state.workouts[0];
    startSession(w.id);
    selectExercise(0);
    state.activeExercise.rest = '1 min';
    state.weight = 60; state.repInput = '8';
    addSet();
  });
  const before = await page.evaluate(() => state.restEndsAt);
  await page.locator('#restPlusBtn').click();
  const after = await page.evaluate(() => state.restEndsAt);
  ok('+30s adds ~30000ms to restEndsAt', Math.abs((after - before) - 30000) < 50, `${after - before}`);

  await page.locator('#restTimerValue').waitFor({ state: 'visible' });
  await page.evaluate(() => skipRest());
  const afterSkip = await page.evaluate(() => state.restEndsAt);
  ok('skip clears restEndsAt', afterSkip === null);
  const hidden = await page.locator('#restTimerValue').count();
  ok('countdown widget is removed from the DOM after skip', hidden === 0);
  await ctx.close();
}

console.log('\n── Rest reaching zero shows "Rest complete" and stops ticking ──');
{
  const { ctx, page } = await fresh();
  await page.evaluate(() => {
    const w = state.workouts[0];
    startSession(w.id);
    selectExercise(0);
    state.weight = 60; state.repInput = '8';
    addSet();
    // Force the countdown to be nearly over without waiting minutes for real.
    state.restEndsAt = Date.now() + 1200;
    render();
  });
  await page.waitForTimeout(2500);
  const text = await page.locator('#restTimerValue').textContent();
  ok('shows "Rest complete" once the countdown reaches zero', text === 'Rest complete', text);
  const plusDisabled = await page.locator('#restPlusBtn').isDisabled();
  ok('+30s is disabled once rest is complete', plusDisabled);
  await ctx.close();
}

console.log('\n── Only one interval is ever active after logging several sets ──');
{
  const { ctx, page } = await fresh();
  await page.evaluate(() => {
    const w = state.workouts[0];
    startSession(w.id);
    selectExercise(0);
    state.activeExercise.rest = '3 min';
  });
  // Log 3 sets in a row (each addSet() is a fresh setState -> render -> the
  // render() dispatcher's startRestInterval() call).
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => { state.weight = 60; state.repInput = '8'; addSet(); });
  }
  // Instrument setInterval AFTER the sets are logged, then trigger one more
  // logged set and confirm exactly one new setInterval call happens (proving
  // startRestInterval always clears its predecessor first rather than
  // stacking additional live intervals).
  await page.evaluate(() => {
    window.__intervalCalls = 0;
    const orig = window.setInterval;
    window.setInterval = function (...args) { window.__intervalCalls++; return orig.apply(window, args); };
  });
  await page.evaluate(() => { state.weight = 60; state.repInput = '8'; addSet(); });
  const calls = await page.evaluate(() => window.__intervalCalls);
  ok('logging one more set schedules exactly one new interval (old one cleared first)', calls === 1, String(calls));
  await ctx.close();
}

console.log('\n── Interval is cleared when the exercise/view is left ──');
{
  const { ctx, page } = await fresh();
  await page.evaluate(() => {
    const w = state.workouts[0];
    startSession(w.id);
    selectExercise(0);
    state.weight = 60; state.repInput = '8';
    addSet();
  });
  const runningBefore = await page.evaluate(() => _restIntervalId !== null);
  ok('interval is running while resting on the exercise screen', runningBefore);
  await page.evaluate(() => goBack());
  const runningAfter = await page.evaluate(() => _restIntervalId !== null);
  ok('interval is cleared after leaving the exercise (goBack)', !runningAfter);
  const restAfter = await page.evaluate(() => state.restEndsAt);
  ok('restEndsAt is cleared too', restAfter === null);
  await ctx.close();
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
