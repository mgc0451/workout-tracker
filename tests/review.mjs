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

// ── R1: exercise removed from the workout mid-session ─────────────────────
console.log('\n── R1: logged entry orphaned by an edit mid-session ──');
{
  const { ctx, page } = await fresh(() => {
    localStorage.setItem('workoutHistory', '[]');
    localStorage.setItem('workouts', JSON.stringify([{
      id: 'w1', name: 'New Workout', label: 'NW', color: 3,
      exercises: [{ id: 'e1', name: 'Solo Lift', weight: 50, targetReps: '8-10', rest: '2 min', notes: '', targetSets: 3 }],
    }]));
    localStorage.setItem('currentSession', JSON.stringify({
      sessionType: 'w1', startedAt: '2026-03-14T09:00:00.000Z',
      exercises: [{ exercise: 'Solo Lift', sets: [{ weight: 50, reps: 8 }, { weight: 50, reps: 8 }, { weight: 50, reps: 8 }] }],
    }));
  });
  // Now empty the workout, exactly as the editor would.
  await page.evaluate(() => {
    state.workouts[0].exercises = [];
    saveLS('workouts', state.workouts);
    setState({ view: 'workout', sessionType: 'w1' });
  });
  const labels = await page.locator('.progress-bar-labels').innerText();
  ok('progress label is not the nonsensical "1/0"', !/\b1\s*\/\s*0\b/.test(labels), JSON.stringify(labels));
  ok('progress label reads 0/0', /0\s*\/\s*0/.test(labels), JSON.stringify(labels));
  const btn = await page.locator('.btn-primary').first().innerText();
  ok('complete button is not "(1/0)"', !/\(1\/0\)/.test(btn), JSON.stringify(btn));
  const body = await page.locator('body').innerText();
  ok('orphaned sets surfaced, not silently hidden', /Also logged/i.test(body) && /Solo Lift/.test(body), body.slice(0, 300));
  ok('orphan still saved on completion (no data loss)',
    await page.evaluate(() => { completeSession(); return JSON.parse(localStorage.getItem('workoutHistory')).some(h => h.exercise === 'Solo Lift'); }));
  await ctx.close();
}

// ── R2: rep PR at a weight never lifted before ────────────────────────────
console.log('\n── R2: no Rep PR at a weight with no prior history ──');
{
  const { ctx, page } = await fresh(() => {
    localStorage.setItem('workoutHistory', JSON.stringify([
      { date: '2026-03-01T09:00:00.000Z', exercise: 'Bench', session: 'A',
        sets: [{ weight: 60, reps: 8 }, { weight: 60, reps: 8 }] },
    ]));
  });
  const r = await page.evaluate(() => ({
    novelWeight: detectPRs('Bench', { weight: 43, reps: 1 }, []).map(p => p.type),
    genuineRep:  detectPRs('Bench', { weight: 60, reps: 10 }, []).map(p => p.type),
    genuineWeight: detectPRs('Bench', { weight: 80, reps: 8 }, []).map(p => p.type),
  }));
  ok('1 rep @ 43kg (never lifted, below max) awards no Rep PR', !r.novelWeight.includes('reps'), JSON.stringify(r.novelWeight));
  ok('10 reps @ 60kg (beats 8 @ 60kg) still awards a Rep PR', r.genuineRep.includes('reps'), JSON.stringify(r.genuineRep));
  ok('80kg still awards a genuine Weight PR', r.genuineWeight.includes('weight'), JSON.stringify(r.genuineWeight));
  await ctx.close();
}

// ── R3: clampSets on an emptied editor field ──────────────────────────────
console.log('\n── R3: empty target-sets field falls back to the default ──');
{
  const { ctx, page } = await fresh();
  const r = await page.evaluate(() => ({
    empty: clampSets(''), blank: clampSets('   '), nul: clampSets(null), undef: clampSets(undefined),
    zero: clampSets(0), neg: clampSets(-4), big: clampSets(99), junk: clampSets('abc'), five: clampSets('5'),
  }));
  ok('"" -> 3 (default, not 1)', r.empty === 3, String(r.empty));
  ok('"   " -> 3', r.blank === 3, String(r.blank));
  ok('null/undefined -> 3', r.nul === 3 && r.undef === 3, `${r.nul}/${r.undef}`);
  ok('explicit 0 -> 1 (floor)', r.zero === 1, String(r.zero));
  ok('-4 -> 1, 99 -> 10, "abc" -> 3, "5" -> 5',
    r.neg === 1 && r.big === 10 && r.junk === 3 && r.five === 5, JSON.stringify(r));
  await ctx.close();
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
