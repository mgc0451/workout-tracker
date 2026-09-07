# Beta handover

## Current state

The branch contains an opt-in Command Center Beta beside Classic. Classic is
unchanged apart from its `Beta` link. Beta uses the same workout, history,
active-session and sync records, and the root service worker caches both shells.

The latest Beta hardening also verifies a real set is logged before asserting a
cross-shell session handoff. This matches the existing invariant that a newly
selected workout is not persisted until meaningful progress exists.

The visual implementation now covers the whole training path rather than only
the landing screen. `renderWorkout()` owns the live session console and movement
queue; `renderExercise()` owns the focused lift stage and prescription strip.
Their controls continue to call the original session, reorder, skip, input and
set-edit actions.

## Rebase status

At the time of this handover, the environment could not fetch the moved
upstream `main`: HTTPS access to GitHub failed with `CONNECT tunnel failed,
response 403`. The checkout has no locally available `main` or remote-tracking
commit newer than the branch base. Do not describe this branch as rebased until
the following succeeds in an environment with repository access:

```bash
git fetch origin main
git rebase origin/main
```

If conflicts occur, use the integration strategy in `ARCHITECTURE.md`. In
particular, do not accept the old copied Beta core over newer Classic fixes.

## Required pre-merge checks

```bash
git diff origin/main...HEAD --check
git diff origin/main...HEAD | grep -c SEED_HISTORY  # expected: 0
node tests/run.mjs
```

Manually verify on a phone-sized viewport:

1. Classic loads and its existing workout flow is unchanged.
2. The Classic `Beta` link opens `/beta/`.
3. Starting and logging a set in Beta produces a resumable Classic session.
4. Editing a shared workout in either shell is visible in the other.
5. Weight entry accepts intermediate decimal input without dismissing focus.
6. Beta and Classic each reload to the correct document while offline.
7. The Beta `Classic` link returns to the stable shell.

## Files that normally move together

- A shared behavior change: `index.html`, `beta/index.html`, and relevant tests.
- A Beta visual change: `beta/index.html` and/or `beta/beta.css` only.
- A shell asset change: the asset plus `sw.js`, its cache version and PWA tests.
- A storage change: both documents, migration/validator tests, and these docs.

## Known follow-up

The duplicated inline core is the principal maintenance risk. A future shared
module extraction is reasonable, but it must be isolated from design work and
must prove identical Classic behavior before the duplicate is removed.
