import { chromium, devices } from './_playwright.mjs';

const URL = process.env.APP_URL || 'http://localhost:8199/index.html';
let pass = 0, fail = 0;
const ok  = (n, c, extra = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${extra}`)); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
page.on('pageerror', e => { fail++; console.log('  PAGE ERROR:', e.message); });

// Navigate to Session B -> Deadlift. `reset` wipes the in-flight session so
// each test starts from zero logged sets.
// Home no longer lists workouts directly; it has a single START WORKOUT
// entry point leading to the picker.
async function toDeadlift(reset = false) {
  await page.goto(URL);
  if (reset) {
    await page.evaluate(() => localStorage.removeItem('currentSession'));
    await page.goto(URL);
  }
  await page.getByRole('button', { name: /START WORKOUT/i }).click();
  await page.getByRole('button', { name: /Session B/ }).first().click();
  await page.getByRole('button', { name: /Deadlift/ }).first().click();
  await page.waitForSelector('#weightInput');
}

// Reps are now a native number input, not a numpad.
async function logSet(page, reps) {
  await page.locator('#repsInput').fill(String(reps));
  await page.locator('#btnLogSet').click();
}

console.log('\n── Test 1: focus retention while typing 82.5 ──');
await toDeadlift(true);
const w = page.locator('#weightInput');
await w.click();
await w.fill('');
const focusTrace = [];
for (const ch of ['8', '2', '.', '5']) {
  await page.keyboard.type(ch);
  focusTrace.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName));
}
ok('focus stays on #weightInput for every keystroke', focusTrace.every(f => f === 'weightInput'), JSON.stringify(focusTrace));
ok('field reads 82.5', (await w.inputValue()) === '82.5', `got "${await w.inputValue()}"`);
const repTxt = (await page.locator('#repsInput').inputValue()).trim();
ok('reps display untouched by weight typing', !/82|25|8$/.test(repTxt), `repDisplay="${repTxt}"`);
ok('state.weight === 82.5', (await page.evaluate(() => state.weight)) === 82.5, String(await page.evaluate(() => state.weight)));

console.log('\n── Test 2: clearing the field ──');
await w.click();
await page.keyboard.press('Control+a');
await page.keyboard.press('Backspace');
ok('field stays empty while focused (does not snap to 0)', (await w.inputValue()) === '', `got "${await w.inputValue()}"`);
await page.locator('body').click({ position: { x: 5, y: 5 } });
ok('normalises to 0 on blur', (await w.inputValue()) === '0', `got "${await w.inputValue()}"`);

console.log('\n── Test 3: mid-typed "82." must not log a 0kg set (trap 1) ──');
await toDeadlift(true);
await w.click();
await w.fill('');
await page.keyboard.type('82.');
const midState = await page.evaluate(() => state.weight);
ok('state.weight is not zeroed while "82." is mid-typed', midState !== 0, `state.weight=${midState}`);
await page.keyboard.type('5');
await logSet(page, 8);
const setRow = await page.locator('.set-row').first().textContent();
ok('logged set reads 82.5kg (not 0kg)', /82\.5kg/.test(setRow), `row="${setRow.trim()}"`);

console.log('\n── Test 4: mid-exercise weight change survives reopen ──');
await toDeadlift(true);
await w.click(); await w.fill(''); await page.keyboard.type('60');
await logSet(page, 7);
await page.locator('#weightInput').click();
await page.locator('#weightInput').fill('');
await page.keyboard.type('62.5');
await logSet(page, 7);
await page.getByRole('button', { name: /Save 2 sets & back/ }).click();
await page.getByRole('button', { name: /Deadlift/ }).first().click();
await page.waitForSelector('#weightInput');
ok('reopened exercise restores LAST set weight 62.5', (await page.locator('#weightInput').inputValue()) === '62.5', `got "${await page.locator('#weightInput').inputValue()}"`);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
