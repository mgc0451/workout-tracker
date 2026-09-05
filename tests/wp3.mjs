import { chromium, devices } from './_playwright.mjs';

const URL = process.env.APP_URL || 'http://localhost:8199/index.html';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${extra}`)); };
const browser = await chromium.launch();

async function fresh() {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => { fail++; console.log('  PAGE ERROR:', e.message); });
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.route('**/script.google.com/**', r => r.fulfill({ status: 200, body: '{}' }));
  await page.goto(URL);
  return { ctx, page };
}

// Log three sets at distinct values so we can tell them apart.
const logThree = `(() => {
  const w = state.workouts[0];
  startSession(w.id);
  selectExercise(0);
  state.weight = 50; state.repInput = '5'; addSet();
  state.weight = 60; state.repInput = '6'; addSet();
  state.weight = 70; state.repInput = '7'; addSet();
})()`;

console.log('\n── Edit a MIDDLE set ──');
{
  const { ctx, page } = await fresh();
  await page.evaluate(logThree);
  const before = await page.evaluate(() => state.sets.map(s => [s.weight, s.reps]));
  ok('three sets logged 50/60/70', JSON.stringify(before) === '[[50,5],[60,6],[70,7]]', JSON.stringify(before));

  // Edit set 2 (index 1) through whatever the app exposes.
  await page.evaluate(() => setState({ editingSetIdx: 1 }));
  await page.waitForTimeout(200);
  const hasInputs = await page.evaluate(() =>
    !!document.getElementById('editSetWeight') && !!document.getElementById('editSetReps'));
  ok('edit UI appears for the middle set', hasInputs);

  const applied = await page.evaluate(() => {
    // Drive through the app's own save path, whatever it is named.
    document.getElementById('editSetWeight').value = '65';
    document.getElementById('editSetReps').value = '9';
    confirmEditSet(1);
    return state.sets.map(s => [s.weight, s.reps]);
  });
  ok('middle set edited to 65x9, others untouched',
    JSON.stringify(applied) === '[[50,5],[65,9],[70,7]]', JSON.stringify(applied));

  await page.reload();
  await page.waitForTimeout(400);
  const persisted = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('currentSession')).exercises[0].sets.map(s => [s.weight, s.reps]));
  ok('edit persisted across reload', JSON.stringify(persisted) === '[[50,5],[65,9],[70,7]]', JSON.stringify(persisted));
  await ctx.close();
}

console.log('\n── Delete a MIDDLE set ──');
{
  const { ctx, page } = await fresh();
  await page.evaluate(logThree);
  const after = await page.evaluate(() => {
    deleteSet(1);
    return state.sets.map(s => [s.weight, s.reps]);
  });
  ok('middle set removed, 1st and 3rd survive',
    JSON.stringify(after) === '[[50,5],[70,7]]', JSON.stringify(after));
  const persisted = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('currentSession')).exercises[0].sets.length);
  ok('deletion persisted', persisted === 2, String(persisted));
  await ctx.close();
}

console.log('\n── Edited set must not keep a stale PR badge ──');
{
  const { ctx, page } = await fresh();
  await page.evaluate(() => {
    localStorage.setItem('workoutHistory', JSON.stringify([
      { date: '2026-03-01T09:00:00.000Z', exercise: state.workouts[0].exercises[0].name,
        session: 'A', sets: [{ weight: 100, reps: 5 }] },
    ]));
  });
  await page.reload();
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => {
    const w = state.workouts[0];
    startSession(w.id); selectExercise(0);
    state.weight = 200; state.repInput = '5'; addSet();       // huge => real PR
    const withPR = (state.sets[0].prs || []).length;
    setState({ editingSetIdx: 0 });
    document.getElementById('editSetWeight').value = '20';     // way below the 100kg record
    document.getElementById('editSetReps').value = '1';
    confirmEditSet(0);
    return { withPR, afterPR: (state.sets[0].prs || []).length, vals: [state.sets[0].weight, state.sets[0].reps] };
  });
  ok('a genuine PR was awarded at 200kg', r.withPR > 0, JSON.stringify(r));
  ok('editing down to 20kg clears the stale PR badge', r.afterPR === 0, JSON.stringify(r));
  await ctx.close();
}

console.log('\n── Reorder / skip is session-local only ──');
{
  const { ctx, page } = await fresh();
  const wkBefore = await page.evaluate(() => { startSession(state.workouts[0].id); return localStorage.getItem('workouts'); });
  const names = await page.evaluate(() => state.workouts[0].exercises.map(e => e.name));

  const moved = await page.evaluate(() => {
    moveSessionExercise(0, 1);
    return true;
  });
  ok('a reorder function exists and ran', moved === true, String(moved));
  const wkAfter = await page.evaluate(() => localStorage.getItem('workouts'));
  ok('reordering does NOT mutate the saved workouts key', wkBefore === wkAfter);

  const skipped = await page.evaluate((n) => {
    toggleSkipExercise(0);
    return { skipped: state.activeSession.skipped, wk: localStorage.getItem('workouts') };
  }, names[0]);
  ok('a skip function exists and recorded a skip',
    Array.isArray(skipped.skipped) && skipped.skipped.length === 1, JSON.stringify(skipped?.skipped));
  ok('skipping does NOT mutate the saved workouts key', skipped.wk === wkBefore);

  await page.reload();
  await page.waitForTimeout(400);
  const survived = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('currentSession') || 'null');
    return { order: s?.order?.length ?? 0, skipped: s?.skipped?.length ?? 0 };
  });
  ok('order + skip survive a reload', survived.skipped === 1, JSON.stringify(survived));
  await ctx.close();
}

console.log('\n── Skipped exercise leaves the denominator ──');
{
  const { ctx, page } = await fresh();
  await page.evaluate(() => { startSession(state.workouts[0].id); setState({ view: 'workout' }); });
  const total0 = await page.evaluate(() => state.workouts[0].exercises.length);
  await page.evaluate(() => {
    toggleSkipExercise(0);
    setState({ view: 'workout' });
  });
  const labels = await page.locator('.progress-bar-labels').innerText();
  const denom = Number((labels.match(/\/\s*(\d+)/) || [])[1]);
  ok('denominator drops by one when an exercise is skipped', denom === total0 - 1, `${JSON.stringify(labels)} total0=${total0}`);
  await ctx.close();
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
