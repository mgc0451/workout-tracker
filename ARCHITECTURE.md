# Application architecture

## Goals and boundaries

Workout Tracker is two static, mobile-first application shells served from one
GitHub Pages project:

- **Classic** (`index.html`) is the stable application and rollback path.
- **Beta** (`beta/index.html`) is the opt-in Command Center experience.
- **Shared infrastructure** (icons and browser storage) allows either shell to
  continue the same workout, while each shell owns its offline worker.

There is no build system, server-side application or account layer. A static
HTTP server is sufficient for local development.

## Runtime layout

```text
/index.html                 Classic document, styles, state and behavior
/manifest.webmanifest       Classic PWA metadata
/beta/index.html            Beta document, state and behavior
/beta/beta.css              Beta visual system layered after base CSS
/beta/manifest.webmanifest  Beta PWA metadata
/sw.js                      Classic network/cache coordinator
/beta/sw.js                 Beta-scoped network/cache coordinator
/tests/*.mjs                Mobile Playwright regression suites
```

The Beta document presently contains a copy of the Classic core. This is a
deliberate compatibility-first bridge, not a claim that duplication is the
ideal end state. Extracting shared code would touch the stable shell and should
be a separate, fully tested migration rather than part of visual iteration.

## State and rendering

Each shell keeps an in-memory `state` object and renders the active view into
`#app`. `setState()` performs a full DOM replacement. Input handlers therefore
must not call it while the user is typing. Numeric fields silently update state
and normalize on blur; editor forms remain uncontrolled and are harvested
before structural actions.

The Beta changes presentation and navigation but retains the same actions and
validators. The stable behavioral boundary includes:

- local-storage loading, validation and normalization;
- session start, resume, completion and abandonment;
- exercise selection, set entry, editing and deletion;
- session-local reorder and skip state;
- rest-timer parsing and lifecycle;
- history, progress and PR calculations;
- workout editing and history-aware renaming;
- queued Google Sheets synchronization; and
- escaping of every user-authored value rendered through `innerHTML`.

### Beta presentation structure

Beta deliberately has three distinct levels rather than re-skinning Classic:

1. **Command Center** prioritizes the recommended/resumable protocol, activity
   signals and the training calendar.
2. **Session console** presents live elapsed time, completion telemetry, a
   dominant next-movement card and the reorderable/skippable movement queue.
3. **Lift stage** concentrates load, reps, set progress, rest timing, previous
   performance and the next movement into a single focused logging surface.

These are render-layer concepts only. They call the same session and logging
actions described above and do not introduce Beta-only workout state.

## Persistence contract

Both shells read and write the same origin-scoped keys:

| Key | Ownership | Notes |
|---|---|---|
| `workouts` | Shared | Workout definitions; seeded IDs `A`, `B`, `C` are stable. |
| `workoutHistory` | Shared | Completed exercise entries, newest first. |
| `currentSession` | Shared | Persisted after meaningful session progress. |
| `syncQueue` | Shared | Durable, capped batches awaiting Sheets delivery. |
| `syncLock` | Shared | Expiring cross-tab drain lock. |
| `beta:*` | Beta only | Reserved for nonessential Beta presentation preferences. |

Schema evolution must be backward-compatible with Classic. New optional fields
need lenient validation and normalization. Beta must never write an alternate
shape that Classic interprets as corruption and resets.

## Navigation isolation

Classic links to `beta/` with a plain anchor, and Beta links back to `../`.
Switching versions performs a document navigation instead of toggling a mode in
application state. This isolates DOM, CSS, render state and failure modes while
allowing storage to remain shared.

## Offline architecture

Each shell owns a service worker within its URL boundary. Classic continues to
use the unchanged root worker and fallback. Beta registers `beta/sw.js`, whose
default scope is `/beta/`, and falls back only to `beta/index.html`. This avoids
coupling Beta releases or cache versions to the stable shell. HTML remains
network-first so deployments are not pinned behind an old cache.

Relative paths are required because production is hosted below
`/workout-tracker/`. Cache changes require a cache-version bump in the worker
that owns the changed shell. A Beta asset omitted from its worker's `ASSETS`
list may work online yet fail in the gym.

## Safe integration strategy

When upstream `main` changes:

1. Rebase the branch onto the fetched `main` commit before making new Beta
   changes.
2. Treat upstream Classic behavior as authoritative.
3. Review every upstream change to the stable behavioral boundary above and
   port applicable changes to Beta.
4. Preserve Beta-only metadata, navigation renders, stylesheet link, Classic
   return link and root-worker registration path.
5. Confirm each scoped service worker owns only its shell assets and fallback.
6. Run the complete Playwright suite, not only `beta`.
7. Check that `SEED_HISTORY` did not appear in the diff.

## Longer-term direction

The safest reduction in duplication is to extract validators, normalization,
storage adapters, calculations and session actions into framework-free shared
modules. Do not begin with render code or input handling. Any extraction must
retain static deployment, offline startup, frozen Sheets payloads and all
existing tests for both shells.
