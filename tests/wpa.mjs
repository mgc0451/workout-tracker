import { chromium, devices } from './_playwright.mjs';

const URL = process.env.APP_URL || 'http://localhost:8199/index.html';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${extra}`)); };

const browser = await chromium.launch();

// Each test gets a fresh context => a fresh, empty localStorage origin.
async function fresh(seed) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => { fail++; console.log('  PAGE ERROR:', e.message); });
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.goto(URL);
  if (seed) { await page.evaluate(seed); await page.goto(URL); }
  return { ctx, page };
}

// Home no longer lists workouts; it has one START WORKOUT entry point that
// leads to the picker. Reps are a native number input, not a numpad.
async function openWorkout(page, name) {
  await page.getByRole('button', { name: /START WORKOUT/i }).click();
  await page.getByRole('button', { name }).first().click();
}
async function logSet(page, reps) {
  await page.locator('#repsInput').fill(String(reps));
  await page.locator('#btnLogSet').click();
}

// ── 6: migration for an existing pre-change user ──────────────────────────
console.log('\n── Test 6: migration from pre-change localStorage ──');
{
  const { ctx, page } = await fresh(() => {
    localStorage.setItem('workoutHistory', JSON.stringify([
      { date: '2026-03-13T09:00:00.000Z', exercise: 'Deadlift', session: 'B',
        sets: [{ weight: 87.5, reps: 7 }, { weight: 87.5, reps: 7 }] },
      { date: '2026-03-09T09:00:00.000Z', exercise: 'Leg Press', session: 'A',
        sets: [{ weight: 190, reps: 12 }] },
    ]));
    localStorage.setItem('currentSession', JSON.stringify({
      sessionType: 'B', startedAt: '2026-03-14T09:00:00.000Z',
      exercises: [{ exercise: 'Deadlift', sets: [{ weight: 90, reps: 5 }] }],
    }));
    localStorage.removeItem('workouts');
  });
  const wk = await page.evaluate(() => JSON.parse(localStorage.getItem('workouts') || 'null'));
  ok('workouts seeded', Array.isArray(wk) && wk.length === 3, JSON.stringify(wk)?.slice(0, 120));
  ok('seed ids are A/B/C', JSON.stringify(wk?.map(w => w.id)) === '["A","B","C"]', JSON.stringify(wk?.map(w => w.id)));
  ok('every exercise has targetSets 3', wk?.every(w => w.exercises.every(e => e.targetSets === 3)));
  ok('6 exercises per seed workout', JSON.stringify(wk?.map(w => w.exercises.length)) === '[6,6,6]', JSON.stringify(wk?.map(w => w.exercises.length)));
  const hist = await page.evaluate(() => JSON.parse(localStorage.getItem('workoutHistory')));
  ok('history length unchanged (2)', hist.length === 2, String(hist.length));
  ok('history not retroactively given workoutId', hist.every(h => h.workoutId === undefined));
  const body = await page.locator('body').innerText();
  ok('resume banner survives migration', /in progress/i.test(body) && /RESUME/.test(body), body.slice(0, 200));
  await ctx.close();
}

// ── 7: corrupt workouts data ──────────────────────────────────────────────
console.log('\n── Test 7: corrupt workouts re-seeds without touching history ──');
{
  const { ctx, page } = await fresh(() => {
    localStorage.setItem('workoutHistory', JSON.stringify([
      { date: '2026-03-13T09:00:00.000Z', exercise: 'Deadlift', session: 'B', sets: [{ weight: 87.5, reps: 7 }] },
    ]));
    localStorage.setItem('workouts', '{"broken":1}');
  });
  const wk = await page.evaluate(() => JSON.parse(localStorage.getItem('workouts')));
  ok('re-seeded to 3 workouts', Array.isArray(wk) && wk.length === 3, JSON.stringify(wk).slice(0, 100));
  const hist = await page.evaluate(() => JSON.parse(localStorage.getItem('workoutHistory')));
  ok('history untouched by the re-seed', hist.length === 1, String(hist.length));
  await ctx.close();
}

// ── 11 + empty state ──────────────────────────────────────────────────────
console.log('\n── Test 11: no NEXT badge; zero-workouts empty state ──');
{
  const { ctx, page } = await fresh();
  ok('no .next-badge in the DOM', (await page.locator('.next-badge').count()) === 0);
  ok('no NEXT text on the home screen', !/\bNEXT\b/.test(await page.locator('body').innerText()));
  ok('getNextSession is gone', (await page.evaluate(() => typeof getNextSession)) === 'undefined');
  await page.evaluate(() => localStorage.setItem('workouts', '[]'));
  await page.goto(URL);
  const err = await page.evaluate(() => { try { return document.getElementById('app').innerHTML.length; } catch (e) { return -1; } });
  ok('zero workouts renders without throwing', err > 0, String(err));
  await ctx.close();
}

// ── 9: HTML injection via a user-entered workout name ─────────────────────
console.log('\n── Test 9: user text is escaped, not executed ──');
{
  const evil = `<img src=x onerror="window.__pwned=1">'"`;
  const { ctx, page } = await fresh(() => {
    const w = JSON.parse(localStorage.getItem('workouts'));
    w[0].name = `<img src=x onerror="window.__pwned=1">'"`;
    w[0].exercises[0].name = `<b>Bench</b>'"`;
    localStorage.setItem('workouts', JSON.stringify(w));
  });
  await page.waitForTimeout(300);
  ok('no script executed from workout name', !(await page.evaluate(() => window.__pwned)));
  ok('no injected <img> element', (await page.locator('img[src="x"]').count()) === 0);
  // Home no longer lists workout names; they render on the picker screen.
  await page.getByRole('button', { name: /START WORKOUT/i }).click();
  await page.waitForTimeout(200);
  ok('no script executed on the picker either', !(await page.evaluate(() => window.__pwned)));
  ok('no injected <img> on the picker', (await page.locator('img[src="x"]').count()) === 0);
  ok('name renders as literal text on the picker',
    (await page.locator('body').innerText()).includes(evil), (await page.locator('body').innerText()).slice(0, 300));
  ok('exercise name escaped too',
    (await page.evaluate(() => { const w = state.workouts[0]; startSession(w.id); return document.body.innerText; })).includes(`<b>Bench</b>'"`));
  await ctx.close();
}

// ── 5: per-exercise target sets ───────────────────────────────────────────
console.log('\n── Test 5: per-exercise target sets ──');
{
  const { ctx, page } = await fresh(() => {
    const w = JSON.parse(localStorage.getItem('workouts'));
    w[0].exercises[0].targetSets = 5;   // Session A / Flat Bench Press
    w[0].exercises[1].targetSets = 1;   // Session A / Leg Press
    localStorage.setItem('workouts', JSON.stringify(w));
  });
  ok('targetSets persisted across reload',
    (await page.evaluate(() => JSON.parse(localStorage.getItem('workouts'))[0].exercises[0].targetSets)) === 5);
  await openWorkout(page, /Session A/);
  await page.getByRole('button', { name: /Flat Bench Press/ }).first().click();
  await page.waitForSelector('#weightInput');
  ok('exercise header reads Sets 0/5', /Sets\s*0\s*\/\s*5/.test(await page.locator('.title-sm').first().textContent()), await page.locator('.title-sm').first().textContent());
  for (let i = 0; i < 4; i++) {
    await logSet(page, 8);
  }
  ok('still logging at 4/5 (not complete)', (await page.locator('#btnLogSet').count()) === 1);
  await logSet(page, 8);
  ok('completes at 5 sets', (await page.locator('#btnLogSet').count()) === 0 && /COMPLETE EXERCISE/i.test(await page.locator('body').innerText()));
  await page.getByRole('button', { name: /COMPLETE EXERCISE/i }).click();
  await page.getByRole('button', { name: /Leg Press/ }).first().click();
  await page.waitForSelector('#weightInput');
  ok('1-set exercise reads Sets 0/1', /Sets\s*0\s*\/\s*1/.test(await page.locator('.title-sm').first().textContent()), await page.locator('.title-sm').first().textContent());
  await logSet(page, 9);
  ok('1-set exercise completes after one set', /COMPLETE EXERCISE/i.test(await page.locator('body').innerText()));
  await ctx.close();
}

// ── 8: Sheets payload shape must not change ───────────────────────────────
console.log('\n── Test 8: Google Sheets payload shape ──');
{
  const { ctx, page } = await fresh();
  let payload = null;
  await page.route('**/script.google.com/**', route => {
    try { payload = JSON.parse(route.request().postData() || 'null'); } catch { payload = 'unparseable'; }
    route.fulfill({ status: 200, body: '{}' });
  });
  await openWorkout(page, /Session A/);
  await page.getByRole('button', { name: /Flat Bench Press/ }).first().click();
  await page.waitForSelector('#weightInput');
  await logSet(page, 8);
  await page.getByRole('button', { name: /Save 1 set & back|COMPLETE EXERCISE/i }).first().click();
  await page.getByRole('button', { name: /COMPLETE SESSION/i }).click();
  await page.waitForTimeout(700);
  ok('sync fired', Array.isArray(payload), JSON.stringify(payload)?.slice(0, 120));
  if (Array.isArray(payload)) {
    const keys = Object.keys(payload[0]).sort().join(',');
    ok('payload keys are exactly date,exercise,session,sets', keys === 'date,exercise,session,sets', keys);
    ok('no workoutId leaked to Sheets', payload.every(e => e.workoutId === undefined));
    ok('session is the label, not a raw internal id', payload[0].session === 'A', String(payload[0].session));
  }
  await ctx.close();
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
