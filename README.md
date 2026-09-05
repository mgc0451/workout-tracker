# Workout Tracker

A single-page workout tracker for the gym. Define your own workouts, log sets
against them, and track progression over time. Runs entirely on the device —
no account, no backend, no build step.

**Live:** https://mgc0451.github.io/workout-tracker/

On a phone, open that link and use **Share → Add to Home Screen**. It then
launches fullscreen and works with no signal.

## What it does

- **Your own workouts** — create them from scratch or from a starting
  template, with per-exercise target sets, rep ranges, rest and notes.
- **Logging** — weight and reps per set, with the previous session's numbers
  shown for reference. Any set can be corrected or deleted afterwards.
- **Rest timer** — starts automatically when you log a set, using that
  exercise's own rest interval.
- **Session flexibility** — reorder or skip exercises for the current session
  without editing the workout itself, for when a machine is taken.
- **Progress** — calendar of sessions, per-exercise graphs (weight, estimated
  1RM, volume), and personal-record detection.
- **Offline** — everything is local. Completed sessions queue and sync to
  Google Sheets when a connection returns.

## Running it locally

Any static server will do, since there is nothing to build:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/index.html
```

## Tests

Playwright drives a real browser in a mobile viewport:

```bash
npm i -D playwright && npx playwright install chromium
node tests/run.mjs
```

The runner starts its own server and runs all 9 suites (164 checks).

## Layout

```
index.html            the whole app — markup, CSS and JS
sw.js                 service worker (offline support)
manifest.webmanifest  PWA manifest
tests/                Playwright suites + runner
CLAUDE.md             architecture notes and gotchas for contributors
```

## Data

Everything lives in `localStorage` under `workouts`, `workoutHistory`,
`currentSession` and `syncQueue`. Clearing site data clears your history, so
use **Settings → Copy History** to export first.

## Notes

Deployed to GitHub Pages as a project page under `/workout-tracker/`, so all
asset paths are relative. The service worker is network-first for the page
itself, so new deployments are picked up rather than being pinned to a cached
build.

The Google Apps Script sync URL is committed in `index.html`; anyone with the
repo can post rows to that sheet. See the note at the end of `CLAUDE.md`.
