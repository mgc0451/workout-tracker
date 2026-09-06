# Working on this codebase

A workout tracker used on a phone, in a gym. Everything lives in `index.html`:
markup, CSS and JS in one file, vanilla, no framework, no build step, no
bundler. Data is in `localStorage`. The only data network call is an optional
Google Sheets sync. The UI also fetches Google Fonts (Teko + Hanken Grotesk),
but only after `window` `load` and never render-blocking, so the app works
fully offline (it falls back to `system-ui`).

**Mobile only.** Do not spend effort on desktop behaviour. Assume a phone,
one thumb, possibly no signal.

```
index.html            the entire app
sw.js                 service worker (offline)
manifest.webmanifest  PWA manifest
icon-192.png .. 512   home-screen icons
tests/                Playwright suites — see "Verifying changes"
```

---

## The one thing to understand before changing anything

```js
function setState(patch) { Object.assign(state, patch); render(); }
function render() { app.innerHTML = renderX(); }   // full DOM replacement
```

**Every `setState` destroys and rebuilds the entire screen.** If the user is
typing into an input when that happens, the element they are typing into
ceases to exist. On a phone the keyboard closes; the caret resets; a
half-typed value like `"82."` is parsed, mangled and written back.

Nearly every serious bug in this app's history traces to this. The weight
field once called `setState` on every keystroke — typing `82.5` left the
field reading `0` and put `82` into the reps counter, silently logging a
wrong rep count.

### So: never call `setState` from an input event

Use the live-patch pattern instead — update state without rendering, then
patch only the specific nodes you own:

```js
function setStateSilent(patch) { Object.assign(state, patch); }   // no render()

function onWeightInput(el) {
  ...
  setStateSilent({ weight: n });
  syncModifiedLabel();      // patch the one node that depends on it
}
```

Existing examples to copy: `onWeightInput` / `onWeightBlur`, `onRepsInput` /
`onRepsBlur`, `syncRepUI`, `syncModifiedLabel`, and `tickRestTimer` (patches
the countdown node once a second — a `setState` there would re-render the
whole screen every second and fight the user's typing).

For a form with many fields, the alternative pattern is **uncontrolled inputs
read at commit time**: the inputs are written once per render, nothing
re-renders while the user types, and a single "structural" action reads the
live DOM values back. See `harvestEditorDOM()` (workout editor) and
`confirmEditSet()` (set editing). Anything that re-renders — reorder, add,
remove, save, back — must harvest **first**, or whatever was just typed is
silently discarded.

`render()` also restores focus by element id after the swap, which is what
makes button-triggered re-renders survivable. Give any input you add a stable
`id`.

### The `input[type=number]` trap

`el.value` is the empty string for **both** an empty field *and* a
mid-typed value the parser rejects — `"82."`, `"8e"`. A naive
`parseFloat(el.value) || 0` therefore zeroes the user's data while they are
still typing, and the next logged set records `0kg`.

Distinguish them with `el.validity.badInput` and bail out rather than writing
a zero. Normalise on blur, never on input. Do not "simplify" this away.

---

## Data model

Four `localStorage` keys. Each has a validator next to it in the source;
follow that style for anything new.

| Key | Shape | Validator |
|---|---|---|
| `workouts` | `[{ id, name, label, color, exercises: [{ id, name, weight, targetReps, rest, notes, targetSets }] }]` | `isValidWorkouts` |
| `workoutHistory` | `[{ date, exercise, session, workoutId?, sets: [{ weight, reps }] }]` | `isValidHistory` |
| `currentSession` | `{ sessionType, startedAt, exercises: [{ exercise, sets }], order?, skipped? }` | `isValidSession` |
| `syncQueue` | `[{ id, entries, queuedAt }]` | `isValidSyncQueue` |

Validators are deliberately **lenient**: only genuinely load-bearing fields
are structural, and everything else is repaired by a `normalize*` pass rather
than triggering a destructive reset. An empty `workouts` array is *valid* —
the user may delete every workout.

### Two invariants that are easy to break

**Seeded workouts keep the ids `A` / `B` / `C`.** History rows written before
workouts were user-definable carry `session: 'A'`, and in-flight sessions
carry `sessionType: 'B'`. Because the seeds reuse those ids, upgrading an
existing user needs no migration step. Do not renumber them.

**Exercises are identified by their name string**, in history, PR detection
and the progress graphs alike. Consequences to respect:

- renaming an exercise orphans its history, blanks "Last session", resets its
  graph, and makes `detectPRs` hand out bogus PRs against an empty baseline —
  the editor offers to rewrite matching history entries for this reason;
- two exercises with the same name **within one workout** would silently share
  a session entry, so the editor auto-suffixes duplicates;
- the same name **across different workouts** is intentional and must keep
  working — it is how one lift shares a progression history.

---

## Rules that are not obvious from the code

- **`SEED_HISTORY` is a single ~90KB line.** Never let a formatter touch this
  file; a reflow makes the diff unreviewable. Check `git diff | grep -c
  SEED_HISTORY` is `0` before committing.
- **All user text goes through `esc()`.** Every render path is `innerHTML`, and
  workout/exercise names are user-supplied. Inline `onclick` arguments must be
  numeric indices or generated ids — **never** user text.
- **The Sheets payload shape is frozen.** The Apps Script endpoint is a black
  box we cannot change, so entries are stripped to exactly
  `date, exercise, session, sets` at that boundary.
- **No PRs without prior history.** `Math.max(0, ...[])` is `0`, so an
  unguarded record check awards a PR to the first set of any new exercise, and
  to any weight never lifted before. Both cases are guarded — keep them.
- **Session-local state stays session-local.** Reordering or skipping an
  exercise mid-session writes to `activeSession`, never to `workouts`. A
  machine being occupied must not rewrite the user's plan.

---

## Verifying changes

There is no unit-test framework. Verification is Playwright driving a real
browser in a mobile context, which is the only way to catch the class of bug
this app actually suffers from (focus loss, keyboard dismissal, re-render
races).

```bash
node tests/run.mjs              # all suites — starts its own server
node tests/run.mjs sync pwa     # just those
```

164 checks across 9 suites. They must all pass before committing.

**Adapt navigation if the UI moves; never weaken an assertion to make a suite
go green.** If a suite is wrong, fix the suite deliberately and say so.

| Suite | Covers |
|---|---|
| `wpb` | weight input: focus retention, decimals, clearing, mid-typed values |
| `wpa` | custom workouts, migration, corrupt data, Sheets payload, escaping |
| `bugsad` | history ordering, PR guards, set-shape validation |
| `review` | phantom progress counts, false rep PRs, `clampSets` |
| `pwa` | manifest, meta, service worker, offline rendering |
| `wp3` / `newfeat` | set editing/deletion, PR recompute, reorder/skip |
| `sync` | offline queue: retry, idempotent drain, corrupt queue |
| `resttimer` | parsing, auto-start, survival across re-render, no interval leaks |

Update propagation through the service worker is *not* covered by the suites —
a `page.route` cannot intercept a service-worker fetch, so testing it that way
silently measures nothing. Verify it by editing a served copy on disk and
reloading.

---

## Deployment

GitHub Pages, from `main`, served at `/workout-tracker/` — a **project** page,
not a domain root. Every path in the manifest, the worker registration and the
icons must stay **relative**; an absolute `/` path makes the install silently
do nothing.

The service worker is **network-first for HTML** with a versioned cache. This
is deliberate: a cache-first worker pins the phone to whichever build it saw
first, with no visible reason updates have stopped arriving — worse than
having no offline support. Keep it network-first.

---

## Known issue

The Google Apps Script URL is hardcoded in `index.html` in a public
repository. Anyone who finds it can POST arbitrary rows into the sheet.
Fixing it means rotating the Apps Script deployment URL and adding a shared
secret on the Apps Script side — work outside this repo, not a code change
here.
