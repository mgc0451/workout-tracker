import { chromium, devices } from './_playwright.mjs';

const URL = process.env.APP_URL || 'http://localhost:8199/index.html';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${extra}`)); };

const browser = await chromium.launch();
async function fresh(seed) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => { fail++; console.log('  PAGE ERROR:', e.message); });
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.goto(URL);
  if (seed) { await page.evaluate(seed); await page.goto(URL); }
  return { ctx, page };
}
async function openWorkout(page, name) {
  await page.getByRole('button', { name: /START WORKOUT/i }).click();
  await page.getByRole('button', { name }).first().click();
}
async function logSet(page, reps) {
  await page.locator('#repsInput').fill(String(reps));
  await page.locator('#btnLogSet').click();
}

// ── Feature 1: edit a middle set, persists across reload ─────────────────
console.log('\n── F1a: editing a middle set persists across reload ──');
{
  const { ctx, page } = await fresh(() => localStorage.setItem('workoutHistory', '[]'));
  await openWorkout(page, /Session A/);
  await page.getByRole('button', { name: /Flat Bench Press/ }).first().click();
  await page.waitForSelector('#weightInput');
  await page.locator('#weightInput').fill('60');
  await logSet(page, 8);
  await logSet(page, 8);
  await logSet(page, 8);
  ok('3 sets logged', (await page.locator('.set-row').count()) === 3, String(await page.locator('.set-row').count()));

  // Tap set 2 (index 1) to enter edit mode.
  await page.locator('.set-row-tap').nth(1).click();
  await page.locator('#editSetWeight').fill('65');
  await page.locator('#editSetReps').fill('10');
  await page.locator('button[aria-label="Confirm changes to set 2"]').click();

  const rows = await page.locator('.set-row').allTextContents();
  ok('set 2 now reads 65kg × 10', /65kg × 10/.test(rows[1]), JSON.stringify(rows));
  ok('set 1 and 3 unchanged', /60kg × 8/.test(rows[0]) && /60kg × 8/.test(rows[2]), JSON.stringify(rows));

  await page.reload();
  await page.getByRole('button', { name: /RESUME/i }).click();
  await page.getByRole('button', { name: /Flat Bench Press/ }).first().click();
  await page.waitForSelector('#weightInput');
  const rowsAfterReload = await page.locator('.set-row').allTextContents();
  ok('edit survives reload', /65kg × 10/.test(rowsAfterReload[1]), JSON.stringify(rowsAfterReload));

  const sessionOnDisk = await page.evaluate(() => JSON.parse(localStorage.getItem('currentSession')));
  const benchEntry = sessionOnDisk.exercises.find(e => e.exercise === 'Flat Bench Press');
  ok('persisted set has weight 65 reps 10', benchEntry.sets[1].weight === 65 && benchEntry.sets[1].reps === 10, JSON.stringify(benchEntry.sets[1]));
  await ctx.close();
}

// ── Feature 1: delete a middle set, leaves others intact ─────────────────
console.log('\n── F1b: deleting a middle set leaves the others intact ──');
{
  const { ctx, page } = await fresh(() => localStorage.setItem('workoutHistory', '[]'));
  await openWorkout(page, /Session A/);
  await page.getByRole('button', { name: /Flat Bench Press/ }).first().click();
  await page.waitForSelector('#weightInput');
  await page.locator('#weightInput').fill('40');
  await logSet(page, 8);
  await page.locator('#weightInput').fill('50');
  await logSet(page, 7);
  await page.locator('#weightInput').fill('60');
  await logSet(page, 6);
  ok('3 sets logged with distinct weights', (await page.locator('.set-row').count()) === 3);

  await page.locator('.set-row-tap').nth(1).click(); // middle set: 50kg x 7
  await page.locator('button[aria-label="Delete set 2"]').click();

  const rows = await page.locator('.set-row').allTextContents();
  ok('now only 2 sets remain', rows.length === 2, JSON.stringify(rows));
  ok('remaining sets are the first and third (40kg, 60kg)', /40kg × 8/.test(rows[0]) && /60kg × 6/.test(rows[1]), JSON.stringify(rows));
  ok('title shows Sets 2/3 after delete', /Sets\s*2\s*\/\s*3/.test(await page.locator('.title-sm').first().textContent()));

  const session = await page.evaluate(() => JSON.parse(localStorage.getItem('currentSession')));
  const entry = session.exercises.find(e => e.exercise === 'Flat Bench Press');
  ok('persisted session has 2 sets', entry.sets.length === 2, JSON.stringify(entry.sets));
  await ctx.close();
}

// ── Feature 1: editing a set does not keep a stale PR badge ───────────────
console.log('\n── F1c: editing a set clears a now-invalid PR badge ──');
{
  const { ctx, page } = await fresh(() => {
    localStorage.setItem('workoutHistory', JSON.stringify([
      { date: '2026-03-01T09:00:00.000Z', exercise: 'Flat Bench Press', session: 'A', sets: [{ weight: 60, reps: 8 }] },
    ]));
  });
  await openWorkout(page, /Session A/);
  await page.getByRole('button', { name: /Flat Bench Press/ }).first().click();
  await page.waitForSelector('#weightInput');
  await page.locator('#weightInput').fill('80'); // beats history max of 60kg -> Weight PR
  await logSet(page, 8);
  const badgeBefore = await page.locator('.pr-badge').count();
  ok('a PR badge is shown for the 80kg set', badgeBefore > 0, String(badgeBefore));

  // Edit the set DOWN to 50kg, which no longer beats the 60kg history max.
  await page.locator('.set-row-tap').first().click();
  await page.locator('#editSetWeight').fill('50');
  await page.locator('#editSetReps').fill('8');
  await page.locator('button[aria-label="Confirm changes to set 1"]').click();

  const badgeAfter = await page.locator('.pr-badge').count();
  ok('no stale PR badge remains after editing the set down', badgeAfter === 0, String(badgeAfter));
  const setRow = await page.locator('.set-row').first().textContent();
  ok('set shows the edited value 50kg × 8', /50kg × 8/.test(setRow), setRow);

  // Now edit it back UP past history — should re-earn a genuine PR.
  await page.locator('.set-row-tap').first().click();
  await page.locator('#editSetWeight').fill('90');
  await page.locator('#editSetReps').fill('8');
  await page.locator('button[aria-label="Confirm changes to set 1"]').click();
  ok('editing back up past history re-awards a genuine PR', (await page.locator('.pr-badge').count()) > 0);
  await ctx.close();
}

// ── Feature 1: editing/deleting a set does not break completion detection ─
console.log('\n── F1d: edit/delete does not break Sets n/target or completion ──');
{
  const { ctx, page } = await fresh(() => localStorage.setItem('workoutHistory', '[]'));
  await openWorkout(page, /Session A/);
  await page.getByRole('button', { name: /Flat Bench Press/ }).first().click();
  await page.waitForSelector('#weightInput');
  await page.locator('#weightInput').fill('40');
  for (let i = 0; i < 3; i++) await logSet(page, 8); // targetSets default 3 -> should now be COMPLETE
  ok('reaches COMPLETE EXERCISE at 3/3', /COMPLETE EXERCISE/i.test(await page.locator('body').innerText()));

  // Editing a set's reps (not count) must not un-complete it.
  await page.locator('.set-row-tap').first().click();
  await page.locator('#editSetReps').fill('9');
  await page.locator('button[aria-label="Confirm changes to set 1"]').click();
  ok('still COMPLETE after editing reps (count unchanged)', /COMPLETE EXERCISE/i.test(await page.locator('body').innerText()));

  // Deleting a set drops it below target -> back to logging mode.
  await page.locator('.set-row-tap').first().click();
  await page.locator('button[aria-label="Delete set 1"]').click();
  ok('back to logging after delete drops below target', (await page.locator('#btnLogSet').count()) === 1);
  ok('title now reads Sets 2/3', /Sets\s*2\s*\/\s*3/.test(await page.locator('.title-sm').first().textContent()));
  await ctx.close();
}

// ── Feature 2: reorder exercises, survives reload, does not touch `workouts`
console.log('\n── F2a: reorder persists across reload, workouts key untouched ──');
{
  const { ctx, page } = await fresh(() => localStorage.setItem('workoutHistory', '[]'));
  const workoutsBefore = await page.evaluate(() => localStorage.getItem('workouts'));
  await openWorkout(page, /Session A/);
  await page.waitForSelector('.exercise-row-wrap');
  const namesBefore = await page.locator('.exercise-row-wrap .wk-list-item-name, .exercise-row-wrap [style*="font-weight:700"]').allTextContents();
  const firstName = (await page.locator('.exercise-row-wrap').nth(0).locator('.exercise-item').innerText()).split('\n')[0];
  const secondName = (await page.locator('.exercise-row-wrap').nth(1).locator('.exercise-item').innerText()).split('\n')[0];

  // Move exercise at index 1 up (swap with index 0).
  await page.locator('.exercise-row-wrap').nth(1).locator('.btn-move-up').click();

  const firstNameAfter = (await page.locator('.exercise-row-wrap').nth(0).locator('.exercise-item').innerText()).split('\n')[0];
  const secondNameAfter = (await page.locator('.exercise-row-wrap').nth(1).locator('.exercise-item').innerText()).split('\n')[0];
  ok('exercise 2 moved to position 1', firstNameAfter === secondName, `${firstNameAfter} vs expected ${secondName}`);
  ok('exercise 1 moved to position 2', secondNameAfter === firstName, `${secondNameAfter} vs expected ${firstName}`);

  const workoutsAfterReorder = await page.evaluate(() => localStorage.getItem('workouts'));
  ok('workouts key is byte-identical after a reorder', workoutsAfterReorder === workoutsBefore);

  // No sets were logged, so there's no Resume banner (it only shows once a
  // set exists) — re-selecting the same workout resumes the same
  // activeSession object instead (see startSession's early-return branch).
  await page.reload();
  await openWorkout(page, /Session A/);
  await page.waitForSelector('.exercise-row-wrap');
  const firstNameReload = (await page.locator('.exercise-row-wrap').nth(0).locator('.exercise-item').innerText()).split('\n')[0];
  ok('reorder survives reload', firstNameReload === secondName, `${firstNameReload} vs expected ${secondName}`);

  const workoutsAfterReload = await page.evaluate(() => localStorage.getItem('workouts'));
  ok('workouts key still byte-identical after reload', workoutsAfterReload === workoutsBefore);
  await ctx.close();
}

// ── Feature 2: skip excludes from completion denominator, sets preserved ──
console.log('\n── F2b: skip excludes from denominator; logged sets preserved ──');
{
  const { ctx, page } = await fresh(() => localStorage.setItem('workoutHistory', '[]'));
  await openWorkout(page, /Session A/);
  await page.waitForSelector('.exercise-row-wrap');
  const total = await page.locator('.exercise-row-wrap').count();
  ok('Session A has 6 exercises', total === 6, String(total));

  // Log a couple of sets on the LAST exercise (Rope Pushdown), then skip it,
  // and skip every other exercise except the first — completing just the
  // first exercise should then let the session read done/total as 1/1.
  const names = [];
  for (let i = 0; i < total; i++) {
    names.push((await page.locator('.exercise-row-wrap').nth(i).locator('.exercise-item').innerText()).split('\n')[0]);
  }
  // Log a set on the last exercise before skipping it, to prove logged sets survive a skip.
  await page.locator('.exercise-row-wrap').nth(total - 1).locator('.exercise-item').click();
  await page.waitForSelector('#weightInput');
  await page.locator('#weightInput').fill('20');
  await logSet(page, 10);
  await page.getByRole('button', { name: /Save 1 set & back/ }).click();
  await page.waitForSelector('.exercise-row-wrap');

  // Skip exercises 1..4 (indices 1-4), leaving index 0 as the only counted one.
  for (let i = 1; i < total; i++) {
    await page.locator('.exercise-row-wrap').nth(i).locator('.btn-skip-toggle').click();
  }
  const progressLabel = await page.locator('.progress-bar-labels').innerText();
  ok('denominator is now 1 (only exercise 0 not skipped)', /\/\s*1\b/.test(progressLabel), progressLabel);

  // Complete exercise 0 to full target sets.
  await page.locator('.exercise-row-wrap').nth(0).locator('.exercise-item').click();
  await page.waitForSelector('#weightInput');
  await page.locator('#weightInput').fill('30');
  for (let i = 0; i < 3; i++) await logSet(page, 8);
  await page.getByRole('button', { name: /COMPLETE EXERCISE/i }).click();
  await page.waitForSelector('.exercise-row-wrap');

  const progressLabel2 = await page.locator('.progress-bar-labels').innerText();
  ok('completing the only non-skipped exercise reads 1/1', /1\s*\/\s*1/.test(progressLabel2), progressLabel2);
  ok('COMPLETE SESSION reads (1/1)', /\(1\/1\)/.test(await page.locator('.btn-primary').first().innerText()));

  // The skipped last exercise's logged set must still be there (not deleted).
  const session = await page.evaluate(() => JSON.parse(localStorage.getItem('currentSession')));
  const lastExEntry = session.exercises.find(e => e.exercise === names[total - 1]);
  ok('skipped exercise with logged sets keeps them', !!lastExEntry && lastExEntry.sets.length === 1, JSON.stringify(lastExEntry));

  // Complete the session and confirm the skipped exercise's set is saved to history too.
  await page.getByRole('button', { name: /COMPLETE SESSION/i }).click();
  const history = await page.evaluate(() => JSON.parse(localStorage.getItem('workoutHistory')));
  ok('skipped-but-logged exercise still saved to history on completion',
    history.some(h => h.exercise === names[total - 1]), JSON.stringify(history.map(h => h.exercise)));
  await ctx.close();
}

// ── Feature 2: old in-flight sessions without order/skipped still load ────
console.log('\n── F2c: pre-feature session (no order/skipped fields) still loads ──');
{
  const { ctx, page } = await fresh(() => {
    localStorage.setItem('workoutHistory', '[]');
    localStorage.setItem('currentSession', JSON.stringify({
      sessionType: 'A', startedAt: '2026-03-14T09:00:00.000Z',
      exercises: [{ exercise: 'Flat Bench Press', sets: [{ weight: 50, reps: 8 }] }],
    }));
  });
  const active = await page.evaluate(() => state.activeSession !== null);
  ok('old-shape session (no order/skipped) is accepted, not discarded', active);
  const body = await page.locator('body').innerText();
  ok('resume banner shows for the old session', /in progress/i.test(body));
  await ctx.close();
}

// ── Feature 2: a name in `order` no longer in the workout does not crash ──
console.log('\n── F2d: stale order entry (workout edited mid-session) is dropped safely ──');
{
  const { ctx, page } = await fresh(() => {
    localStorage.setItem('workoutHistory', '[]');
    localStorage.setItem('currentSession', JSON.stringify({
      sessionType: 'A', startedAt: '2026-03-14T09:00:00.000Z',
      exercises: [],
      order: ['Ghost Exercise That No Longer Exists', 'Flat Bench Press'],
      skipped: [],
    }));
  });
  await page.evaluate(() => setState({ view: 'workout', sessionType: 'A' }));
  const rendered = await page.evaluate(() => document.getElementById('app').innerHTML.length);
  ok('renders without throwing despite a stale order entry', rendered > 0, String(rendered));
  const body = await page.locator('body').innerText();
  ok('no phantom "Ghost Exercise" row rendered', !/Ghost Exercise/.test(body), body.slice(0, 300));
  ok('real exercises still all present (6 rows)', (await page.locator('.exercise-row-wrap').count()) === 6);
  await ctx.close();
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
