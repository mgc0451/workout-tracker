import { chromium, devices } from './_playwright.mjs';

const URL = process.env.APP_URL || 'http://localhost:8199/index.html';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${extra}`)); };
const browser = await chromium.launch();
async function fresh(seed) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => { fail++; console.log('  PAGE ERROR:', e.message); });
  await page.goto(URL);
  if (seed) { await page.evaluate(seed); await page.goto(URL); }
  return { ctx, page };
}

// ── A: saveEditDate must re-sort history newest-first ─────────────────────
console.log('\n── Bug A: editing a date re-sorts history ──');
{
  const { ctx, page } = await fresh(() => {
    localStorage.setItem('workoutHistory', JSON.stringify([
      { date: '2026-03-20T09:00:00.000Z', exercise: 'Deadlift', session: 'B', sets: [{ weight: 100, reps: 5 }] },
      { date: '2026-03-10T09:00:00.000Z', exercise: 'Deadlift', session: 'B', sets: [{ weight: 90, reps: 5 }] },
    ]));
  });
  // Move the NEWEST entry (100kg) back to an older date than the other.
  const moved = await page.evaluate(() => {
    const target = new Date(state.history[0].date).toLocaleDateString();
    saveEditDate(target, '2026-03-01');
    return state.history.map(e => [e.date.slice(0, 10), e.sets[0].weight]);
  });
  ok('history re-sorted newest-first after a date edit',
    moved[0][0] === '2026-03-10' && moved[1][0] === '2026-03-01', JSON.stringify(moved));
  const last = await page.evaluate(() => getExerciseHistory('Deadlift')[0].sets[0].weight);
  ok('"Last session" now reads the genuinely most recent entry (90kg)', last === 90, `got ${last}kg`);
  await ctx.close();
}

// ── B: dead progress view removed ─────────────────────────────────────────
console.log('\n── Bug B: unreachable progress view removed ──');
{
  const { ctx, page } = await fresh();
  ok('renderProgress is gone', (await page.evaluate(() => typeof renderProgress)) === 'undefined');
  ok('progress still reachable via the home tab',
    await page.evaluate(() => { setState({ homeTab: 'progress' }); return /Exercise|No data|2 sessions/i.test(document.body.innerText); }));
  await ctx.close();
}

// ── C: no PRs against an empty history ────────────────────────────────────
console.log('\n── Bug C: first set of a brand-new exercise awards no PR ──');
{
  const { ctx, page } = await fresh(() => {
    localStorage.setItem('workoutHistory', '[]');
    const w = JSON.parse(localStorage.getItem('workouts'));
    w[0].exercises.unshift({ id: 'e_new', name: 'Brand New Lift', weight: 50, targetReps: '8-10', rest: '2 min', notes: '', targetSets: 3 });
    localStorage.setItem('workouts', JSON.stringify(w));
  });
  const prs = await page.evaluate(() => detectPRs('Brand New Lift', { weight: 60, reps: 10 }, []));
  ok('no PRs awarded with zero history', Array.isArray(prs) && prs.length === 0, JSON.stringify(prs));
  // ...but a genuine PR against real history still fires.
  const real = await page.evaluate(() => {
    state.history = [{ date: '2026-03-01T09:00:00.000Z', exercise: 'Brand New Lift', session: 'A', sets: [{ weight: 50, reps: 8 }] }];
    return detectPRs('Brand New Lift', { weight: 60, reps: 10 }, []).map(p => p.type);
  });
  ok('real PRs still detected once history exists', real.includes('weight'), JSON.stringify(real));
  await ctx.close();
}

// ── D: isValidHistory rejects malformed set contents ──────────────────────
console.log('\n── Bug D: malformed sets rejected before they can throw ──');
{
  const { ctx, page } = await fresh(() => {
    localStorage.setItem('workoutHistory', JSON.stringify([
      { date: '2026-03-20T09:00:00.000Z', exercise: 'Deadlift', session: 'B', sets: [null] },
    ]));
  });
  ok('corrupt sets:[null] rejected and reset', (await page.evaluate(() => state.history.length)) === 0,
    String(await page.evaluate(() => JSON.stringify(state.history))));
  ok('app still renders', (await page.evaluate(() => document.getElementById('app').innerHTML.length)) > 0);
  await ctx.close();
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
