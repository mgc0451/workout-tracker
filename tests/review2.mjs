// Regression tests for the round-2 adversarial review findings.
import { chromium, devices } from './_playwright.mjs';

const URL = process.env.APP_URL || 'http://localhost:8199/index.html';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${extra}`)); };
const browser = await chromium.launch();

async function fresh(routeSheets) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => { fail++; console.log('  PAGE ERROR:', e.message); });
  page.on('dialog', d => d.accept().catch(() => {}));
  if (routeSheets) await ctx.route('**/script.google.com/**', routeSheets);
  else await ctx.route('**/script.google.com/**', r => r.fulfill({ status: 200, body: '{}' }));
  await page.goto(URL);
  await page.waitForTimeout(300);
  return { ctx, page };
}
const batch = (name) => ({
  id: 'b-' + name, queuedAt: '2026-09-01T00:00:00.000Z',
  entries: [{ date: '2026-09-01T00:00:00.000Z', exercise: name, session: 'A', sets: [{ weight: 1, reps: 1 }] }],
});

console.log('\n── F1: a hung request must not disable sync forever ──');
{
  let hits = 0, release = null;
  const { ctx, page } = await fresh(route => { hits++; if (hits === 1) { release = route; return; } route.fulfill({ status: 200, body: '{}' }); });
  await page.evaluate(b => localStorage.setItem('syncQueue', JSON.stringify([b])), batch('Hang'));
  page.evaluate(() => drainSyncQueue()).catch(() => {});   // hangs on the first request
  await page.waitForTimeout(600);
  const stuckMid = await page.evaluate(() => _syncDraining);
  ok('guard is held while a request is in flight', stuckMid === true, String(stuckMid));

  // SYNC_TIMEOUT_MS is 15s; wait past it.
  await page.waitForTimeout(16000);
  const released = await page.evaluate(() => _syncDraining);
  ok('guard released after the request times out', released === false, String(released));

  await page.evaluate(b => {
    const q = JSON.parse(localStorage.getItem('syncQueue') || '[]'); q.push(b);
    localStorage.setItem('syncQueue', JSON.stringify(q));
  }, batch('Later'));
  await page.evaluate(() => drainSyncQueue());
  await page.waitForTimeout(1200);
  const remaining = await page.evaluate(() => JSON.parse(localStorage.getItem('syncQueue') || '[]').length);
  ok('a later drain still reaches the network', hits > 1, `requests=${hits}`);
  ok('queue drains after the hung attempt', remaining === 0, `left=${remaining}`);
  if (release) try { await release.abort(); } catch {}
  await ctx.close();
}

console.log('\n── F2: two instances must not double-send ──');
{
  let hits = 0;
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  await ctx.route('**/script.google.com/**', async route => { hits++; await new Promise(r => setTimeout(r, 800)); route.fulfill({ status: 200, body: '{}' }); });
  const p1 = await ctx.newPage(); await p1.goto(URL);
  const p2 = await ctx.newPage(); await p2.goto(URL);
  await p1.evaluate(b => localStorage.setItem('syncQueue', JSON.stringify([b])), batch('Dup'));
  await p2.reload(); await p2.waitForTimeout(300);
  await Promise.all([
    p1.evaluate(() => drainSyncQueue()).catch(() => {}),
    p2.evaluate(() => drainSyncQueue()).catch(() => {}),
  ]);
  await p1.waitForTimeout(500);
  ok('batch sent exactly once across two instances', hits === 1, `requests=${hits}`);
  await ctx.close();
}

console.log('\n── F3: a skip-only session must stay reachable ──');
{
  const { ctx, page } = await fresh();
  await page.evaluate(() => {
    startSession(state.workouts[0].id);
    setState({ view: 'workout' });
    toggleSkipExercise(0);
  });
  const abandonOnWorkout = await page.locator('button:has-text("Abandon Session")').count();
  ok('Abandon is available on the workout screen', abandonOnWorkout === 1, String(abandonOnWorkout));
  const completeShown = await page.locator('button:has-text("COMPLETE SESSION")').count();
  ok('Complete is hidden with nothing logged (would be a dead button)', completeShown === 0, String(completeShown));

  await page.evaluate(() => setState({ view: 'select', sessionType: null }));
  const banner = await page.locator('.resume-banner').count();
  ok('resume banner appears on home for a skip-only session', banner === 1, String(banner));
  await page.evaluate(() => abandonSession());
  const cleared = await page.evaluate(() => localStorage.getItem('currentSession'));
  ok('it can actually be abandoned', cleared === null, String(cleared));
  await ctx.close();
}

console.log('\n── F4: an open set edit must survive another action ──');
{
  const { ctx, page } = await fresh();
  const r = await page.evaluate(() => {
    startSession(state.workouts[0].id);
    selectExercise(0);
    state.weight = 50; state.repInput = '8'; addSet();
    state.weight = 50; state.repInput = '8'; addSet();
    setState({ editingSetIdx: 0 });
    document.getElementById('editSetWeight').value = '999';
    document.getElementById('editSetReps').value = '77';
    state.repInput = '8'; addSet();               // a different action, mid-edit
    return state.sets.map(s => [s.weight, s.reps]);
  });
  ok('the typed edit is kept, not silently reverted',
    JSON.stringify(r[0]) === '[999,77]', JSON.stringify(r));
  ok('the new set was still logged', r.length === 3, JSON.stringify(r));
  await ctx.close();
}

console.log('\n── F6: skipping a finished exercise must not read n/0 ──');
{
  const { ctx, page } = await fresh();
  await page.evaluate(() => {
    startSession(state.workouts[0].id);
    selectExercise(0);
    const t = targetSetsFor(state.activeExercise);
    for (let i = 0; i < t; i++) { state.weight = 50; state.repInput = '8'; addSet(); }
    completeExercise();
    state.workouts[0].exercises.forEach((_, i) => toggleSkipExercise(0));
    setState({ view: 'workout' });
  });
  const labels = await page.locator('.progress-bar-labels').innerText();
  const m = labels.match(/(\d+)\s*\/\s*(\d+)/);
  ok('numerator never exceeds the denominator', m && Number(m[1]) <= Number(m[2]), JSON.stringify(labels));
  await ctx.close();
}

console.log('\n── F7: keyboard inset is published for bottom controls ──');
{
  const { ctx, page } = await fresh();
  const wired = await page.evaluate(() => {
    const css = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules].map(r => r.cssText); } catch { return []; } }).join('\n');
    return { usesVar: /--kb/.test(css), hasListener: typeof window.visualViewport === 'object' };
  });
  ok('the sticky log button offsets by --kb', wired.usesVar);
  ok('--kb resolves to 0px with no keyboard open',
    (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--kb').trim() || '0px')) .startsWith('0'));
  await ctx.close();
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
