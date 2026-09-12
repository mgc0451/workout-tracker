# Lift — project handoff

Drop this at the root of the new `lift` repo (as `HANDOFF.md` or fold it into
`CLAUDE.md` once the scaffold exists). It exists so a **cold local session
starts with the decisions already made and the hard-won domain knowledge
already ported** — not so anyone has to re-derive them.

Source project: `mgc0451/workout-tracker` — a single-file vanilla PWA,
`index.html`, ~3,750 lines, live on GitHub Pages. Keep it installed. It is the
fallback, and it is the reference implementation for every rule below.

---

## 1. The decision

**Build Lift as a native iOS app in SwiftUI.**

Rejected, with reasons — so they don't get relitigated:

| Option | Why not |
|---|---|
| Keep the vanilla PWA | Can't do haptics, lock-screen rest timer, or a reliable background timer. Those are the three things the current app is actually bad at. |
| Svelte/Vite PWA rewrite | Same ceiling. Nicer code, same missing capabilities. |
| Capacitor (web app in a native shell) | Pays the **identical** sideloading tax as native for a fraction of the payoff — Live Activities still need a Swift widget extension, and web-view scroll never feels right. The half-step only makes sense if you also want a web version. We don't. |

Deployment: **free Apple Developer account, sideloaded via Xcode.** Accepted
knowingly:

- Provisioning profiles expire **7 days** from issuance. When one expires the
  app **stops launching** — no warning. Rebuild from Xcode buys another 7 days.
- Limits: 3 devices, 3 apps per device, 10 App IDs per 7 days.
- Weekly re-signing is **accepted**. Worth scripting early (`xcodebuild` +
  `xcrun devicectl` on a weekly launchd job while the phone is on wifi) — but
  verify it works unattended rather than assuming it.
- The $99/yr paid account removes this entirely (1-year profiles, TestFlight).
  Not chosen now; revisit if the weekly ritual gets annoying.

Target: **iPhone only.** No iPad, no Mac Catalyst, no landscape. One thumb, in
a gym, possibly no signal. Same constraint as the old app — it earned its keep.

---

## 2. Architecture

Two targets, and the split is load-bearing:

```
LiftKit/     Swift package. NO SwiftUI, NO UIKit imports. Pure domain logic.
Lift/        SwiftUI app. Views, Live Activity, haptics, persistence glue.
```

**Why the split matters:** Swift runs on Linux, so `LiftKit` compiles and its
tests run anywhere — including in a cloud Claude Code session with no Mac. The
UI layer is Mac-only. Without this split, any remote session is reduced to
writing code nobody can verify. Put every rule in section 4 inside `LiftKit`
and cover it with tests.

Verify the Linux toolchain early (`swift test` in a plain Linux container) so
this is a proven property, not an aspiration.

**Persistence:** start with a plain `Codable` store writing JSON to
Application Support, mirroring today's four keys. It is boring, debuggable, and
trivially importable from the old app's export. SwiftData is a reasonable later
migration, not a day-one requirement — don't let a persistence framework
dictate the domain model.

**Suggested stack:** SwiftUI + Observation (`@Observable`), Swift Charts for
progress graphs, ActivityKit for the rest-timer Live Activity, Core Haptics,
`UNUserNotificationCenter` for rest-complete alerts. No third-party
dependencies needed at the start.

---

## 3. Feature parity inventory

Everything the current app does. Ship order is section 7; this is the
checklist for "is Lift actually a replacement yet".

**Screens** (`state.view` in the old app):

- `select` — home. Two tabs: **Workout** (pick a session, resume in-flight
  session, quick stats, week streak banner, month calendar heatmap) and
  **Progress** (per-exercise graph, metric switcher).
- `workout` — exercise list for the chosen workout: per-exercise completion
  state, progress bar, reorder, skip, orphan warnings, complete session.
- `exercise` — the logging screen. Weight orb, reps stepper, log set, set list
  with inline edit/delete, PR badges, progression banner, rest timer.
- `summary` — post-session recap with count-up animations.
- `history` — sessions grouped by day, exercise filter, delete-day with undo,
  edit a session's date.
- `settings` — export history, clear all history. (The old sync-status row goes
  away with Sheets; whatever replaces backup per §8 gets its status here.)
- `workouts` / `workoutNew` / `workoutEdit` — full workout CRUD: create from
  template or blank, duplicate, delete, rename, colour, add/remove/reorder
  exercises, per-exercise weight/targetReps/rest/notes/targetSets.

**Behaviours that are easy to forget:**

- In-flight session survives app kill and is offered for resume.
- Session-local reorder and skip (never writes back to the workout definition).
- Last-session reference weight shown on the logging screen, with a "modified"
  marker when the user changes it.
- Rest timer auto-starts on logging a set, parsed from the exercise's rest
  string.
- PR badges are computed at log time and stored on the set.

**Explicitly dropped:** Google Sheets sync, and with it the offline sync queue,
the 30s cross-tab lock, the 15s request timeout, the opaque `no-cors` response
handling and the frozen payload shape. See §8 — this removes your only
off-device backup, so it needs a replacement, not just a deletion.

---

## 4. The rulebook — ported

Every bullet here is a bug that was expensive to find in the old app. The
biggest risk of a rewrite is silently reintroducing them.

### 4.1 Rules that carry over unchanged (domain truth)

**Exercise identity moves from name strings to stable IDs.** *(Decided —
changed from the old app. See §5 for the model and §6 for the migration.)*

In the old app, exercises are identified by their **name string** everywhere:
history, PR detection, progress graphs. That produced three behaviours you must
understand, because the new model has to preserve the good one and delete the
bad ones:

- **Bad:** renaming an exercise orphaned its history, blanked "last session",
  reset its graph, and made PR detection hand out bogus records against a
  suddenly-empty baseline. The old editor papered over this by offering to
  rewrite matching history entries on rename.
- **Bad:** two exercises with the same name *within one workout* silently
  shared a session entry, so the editor auto-suffixed duplicates.
- **Good, and must survive:** the same name *across different workouts* is
  intentional — it's how one lift shares a progression history.

With stable IDs, the first two problems disappear structurally: renaming is
free and needs no history rewrite (delete that confirm prompt), and the third
behaviour becomes an explicit fact of the model rather than an emergent
property of string matching.

**The ID must be a global exercise identity, not a per-workout row id.** The
old `ExerciseDef.id` field is useless for this — it's regenerated by the
normalise pass when missing and never appears in history. Model it as a
top-level **exercise catalog**: one `Exercise` per real-world lift, with
workouts holding *references* plus their own prescription.

**Two rules that come with the change:**

1. **Session entries key on the workout slot, not the exercise.** If the same
   lift legitimately appears twice in one workout (two bench slots, different
   prescriptions), keying the in-flight session by exercise ID would silently
   merge them — the exact bug name-keying had, reintroduced. Key
   `ActiveSession.exercises` by the workout's **slot id**; record the
   `exerciseId` on the logged history entry.
2. **History still records the display name at log time.** Keep it as
   `legacyName` alongside `exerciseId`. It costs nothing, makes the migration
   auditable, and means a botched merge is recoverable.

**No PRs without prior history.** `max(0, [])` is `0`, so an unguarded record
check awards a PR to the first set of any new exercise. Three PR types, each
with its own guard:

- *Weight PR* — `newSet.weight > maxWeight`, only if the exercise has **any**
  prior sets at all.
- *Rep PR* — scoped to sets at **this exact weight**, and only awarded if that
  weight has been lifted before. Without that check, one rep at a weight far
  below the historical max wins a "Rep PR".
- *Volume PR* — `weight × reps` beats the historical max.

Also: a PR type already shown on an earlier set in the *current* session is not
awarded twice.

**Progression status needs a complete set count and a parseable range.**
Returns nothing until `sets.count >= targetSets`. Target reps is free text
(`"6-8"`, but also `"AMRAP"`, `"10"`); if it doesn't parse as `min-max`, show
no banner rather than pinning it to one state forever. Three outcomes: all sets
at/above max → "increase weight"; all at/above min → "good"; otherwise "push
for more reps".

**Rest string parsing.** Takes the **first number** in the string (the lower
bound of a range like `"3-4 min"`). Unit is seconds only if the string contains
"sec" and not "min"; otherwise minutes. Default 90s when absent or unparseable.

**Validators are lenient; repair, don't reset.** Only genuinely load-bearing
fields are structural; everything else gets fixed by a normalise pass. **An
empty workouts array is valid** — the user may delete every workout. A
destructive reset on a schema wobble is how you lose someone's training
history.

**Session-local state stays session-local.** Reordering or skipping an exercise
mid-session writes to the active session, never to the saved workout. A machine
being occupied must not rewrite the user's plan.

**Seeded workout IDs are `A` / `B` / `C`.** Old history rows carry
`session: "A"`; old in-flight sessions carry `sessionType: "B"`. Reusing those
IDs is what lets existing data import with no migration step. Don't renumber.

**Rest end time is stored as an absolute timestamp, never a tick counter,** and
is deliberately *not* persisted — a stale countdown surviving a relaunch must
never display. The absolute-time approach is exactly right for native; carry it
straight into ActivityKit.

### 4.2 Rules that change shape in SwiftUI

**The `setState` re-render landmine — mostly gone, with one survivor.** The old
app rebuilt the entire DOM on every state change, so calling `setState` from an
input event destroyed the field the user was typing into. SwiftUI's diffing
makes that class of bug vanish.

What survives is the **parsing** half, and it is still lethal:

> Never bind a text field directly to a `Double` or `Int`.

A field bound to a number formatter parses on every keystroke. `"82."` and
`"8"` mid-way to `"82.5"` are real intermediate states. The old app logged a
wrong rep count this way — the weight field read `0` and `82` landed in the
reps counter.

Do this instead: bind to a `String`, keep the parsed value separate, parse and
normalise **on commit / focus loss, never per keystroke**, and never write a
zero for an unparseable value — leave the previous value alone. `LiftKit`
should own that parsing function and test it against `""`, `"82."`, `"8e"`,
`"-5"`, `"0"`, `"82.5"`.

**Escaping is no longer a concern.** Every render path in the old app was
`innerHTML` with user-supplied workout and exercise names, so everything went
through `esc()`. SwiftUI `Text` doesn't interpret markup. One entire bug class
deleted — just don't reintroduce it by rendering user text through
`AttributedString(markdown:)`.

**Reduced motion still matters, and the rule is the same.** Never park an
element at an animated *initial* state (opacity 0, scale 0, a hidden dash
offset). The final static look must be the default; motion only adds to it.
Gate with `@Environment(\.accessibilityReduceMotion)`. The old app had counter
count-ups bail out under reduced motion — keep that behaviour.

**Obsolete, don't port:** the `box-shadow: inset` vs `border` CSS specificity
rule, the service worker cache strategy, the `input[type=number]`
`validity.badInput` mechanics (the *principle* survives — see above — the API
doesn't), and the giant single-line `SEED_HISTORY` constant.

---

## 5. Data model

Shapes as they exist today, to be mirrored in `LiftKit`. Note that **history is
per-exercise, not per-session** — completing a session writes N entries that
all share one identical ISO timestamp, and the history screen groups by
calendar day. Preserve that or write a migration that restructures it; don't
half-change it.

The big structural change from the old app: a **top-level exercise catalog**.
An `Exercise` is the real-world lift and owns its identity and history. A
workout holds `ExerciseSlot`s that *reference* the catalog and carry the
prescription for that slot. This is what makes "the same lift in two workouts
shares one progression history" a property of the model rather than a
coincidence of string matching.

```swift
// ---- Catalog: the identity layer ----
struct Exercise: Identifiable {
    let id: ExerciseID        // stable, minted once, never reused
    var name: String          // display only — renaming is now free
}

// ---- Workouts: prescription ----
struct Workout: Identifiable {
    let id: String            // "A"/"B"/"C" for seeds — do not renumber
    var name: String
    var label: String         // ≤3 chars, shown on history rows
    var color: Int            // 0..<8 palette index
    var slots: [ExerciseSlot]
}

struct ExerciseSlot: Identifiable {
    let id: SlotID            // stable per workout row; see §4.1 rule 1
    var exerciseID: ExerciseID
    var weight: Double        // starting/reference weight
    var targetReps: String    // free text: "6-8", "AMRAP", "10"
    var rest: String          // free text: "3-4 min", "90 sec"
    var notes: String
    var targetSets: Int       // clamped, default 3
}

// ---- History ----
struct HistoryEntry {
    var date: Date            // identical across one session's entries
    var exerciseID: ExerciseID
    var legacyName: String    // display name at log time — audit trail
    var session: String       // the workout's label at time of logging
    var workoutID: String?    // absent on pre-workouts-feature rows
    var sets: [LoggedSet]
}

struct LoggedSet {
    var weight: Double
    var reps: Int
    var prs: [PRBadge]        // computed at log time, stored
}

// ---- In-flight session ----
struct ActiveSession {
    var workoutID: String
    var startedAt: Date
    var entries: [SlotID: [LoggedSet]]   // keyed by SLOT, not exercise
    var order: [SlotID]?                 // session-local reorder
    var skipped: Set<SlotID>?            // session-local skips
}
```

Every lookup that was a name comparison in the old app — PR detection, "last
session", progress graphs, best set — becomes an `exerciseID` comparison. That
is the entire point of the change; don't leave any of them keyed on the string.

Derived stats to port: week streak (Monday-start weeks, consecutive), days
since last session, total sessions (distinct calendar days), sessions this week,
best set per exercise, month calendar heatmap.

---

## 6. Getting your real data across

**Do this before you need it.** Your actual training history lives in
`localStorage` on `mgc0451.github.io`. A native app can't read it, and if you
ever clear Safari's site data it's gone with no backup.

1. Old app → Settings → **Export** (copies history JSON to clipboard).
2. Save it to a file. Commit it to the `lift` repo as a fixture — it's both
   your migration input *and* the best possible test data for PR detection,
   streaks and graphs.
3. Build the importer in `LiftKit` as a real, tested function against that
   fixture. Not a one-off script.

The export only covers `workoutHistory`. If you've customised workouts, grab
`workouts` too — Safari dev tools via USB, or add a second export button to the
old app.

### 6.1 The name → ID migration

This runs **once**, against real data, and is not reversible. Treat it as a
tested `LiftKit` function that produces a **report**, not a silent transform.

Baseline measured against the seed history in the old `index.html`: **244
entries, 18 distinct exercise names**, exactly matching the 18 seeded exercises,
with **zero** case-or-whitespace collisions. So the mapping is a clean 1:1, not
a fuzzy-matching problem. Your live storage may have drifted from that — which
is exactly what the report is for.

Algorithm:

1. Collect every distinct `exercise` string across history **and** all workout
   definitions.
2. Bucket by a normalised key (trim, collapse internal whitespace, casefold).
3. Mint one `Exercise` per bucket. Display name = the most frequent spelling,
   ties broken by most recent use.
4. Rewrite history entries: set `exerciseID`, keep the original string as
   `legacyName`.
5. Rewrite workouts into `ExerciseSlot`s referencing the catalog, minting a
   fresh `SlotID` per row.
6. **Emit a report and stop:** every bucket that merged more than one spelling,
   every name found in history but in no workout (orphans — these are real
   logged work, keep them, they just have no current prescription), and total
   counts in vs out. Eyeball it, then commit.

Assert `sets in == sets out`. A migration that loses a single logged set has
failed, however tidy the output looks.

---

## 7. Build order

Each milestone should be runnable in the Simulator before moving on.

1. **`LiftKit` + tests + your real history imported and migrated to IDs.** No
   UI. Run the §6.1 migration and read its report. Prove PR detection,
   progression status, rest parsing, streaks and the number parser against the
   migrated fixture. Confirm `swift test` runs on Linux.
2. **Xcode project, signing, on-device install.** Do this before writing real
   UI — find out now if signing fights you, not in week three. Script the
   weekly rebuild while it's fresh.
3. **Logging flow end to end.** Home → pick workout → exercise → log set →
   complete session → summary. Ugly is fine. This is the path you actually use
   in a gym.
4. **Rest timer, properly.** Absolute end time, Live Activity on the lock
   screen and Dynamic Island, local notification on completion, haptic on
   finish. This is the headline reason for going native — don't leave it last.
5. **History + progress.** Swift Charts, calendar heatmap, day grouping,
   delete-with-undo.
6. **Workout editor.** Full CRUD. Renaming is now free — no history-rewrite
   prompt needed (that confirm dialog exists only because of name-keying).
7. **Backup.** See §8 — must land before cutover, not after.
8. **Polish.** Spring animations, gesture-driven weight adjustment, PR
   celebration, per-set haptics.

Cut over only after two or three real gym sessions on Lift with the old app
still installed.

---

## 8. Open questions

**Settled — do not relitigate:**

- ~~Google Sheets sync~~ — **dropped.** Not ported. The endpoint URL was
  hardcoded in a public repo and the sync was append-only anyway.
- ~~Exercise IDs vs names~~ — **IDs.** See §4.1 and §6.1.

**Still open:**

- **Backup — the one genuine gap.** Dropping Sheets removes the only
  off-device copy of your training history. iOS device backup covers the
  common case, but a lost/wiped phone with a stale backup loses real data.
  Cheapest credible options, in order: (a) CloudKit private database — free,
  automatic, also gives cross-device sync; (b) a periodic JSON export written
  to iCloud Drive via the Files API; (c) a manual export button, which is what
  you have today and depends on you remembering. **Pick one before cutover** —
  the old app's Sheets sync, for all its faults, was doing this job.
- **HealthKit.** Write sessions to Apple Health? Read bodyweight for
  volume-per-kg? Cheap to add, easy to skip.
- **Units.** Everything is kg today and unlabelled in places. Hardcode kg or
  make it a setting.
- **Watch app.** Logging from the wrist is the obvious next thing native
  unlocks. Explicitly out of scope for v1.

---

## 9. Verification

There is no substitute for running it. In a local session Claude Code can drive
the full loop via Bash:

```bash
swift test --package-path LiftKit          # domain logic, also works on Linux
xcodebuild -scheme Lift -destination 'platform=iOS Simulator,name=iPhone 16 Pro'
xcrun simctl boot "iPhone 16 Pro"
xcrun simctl install booted <path>.app && xcrun simctl launch booted <bundle-id>
xcrun simctl io booted screenshot /tmp/shot.png    # then actually look at it
```

Two things the Simulator can't tell you:

- **Haptics don't fire in the Simulator.** Every haptic decision needs a real
  device check.
- **Live Activities / Dynamic Island** should render in a recent Simulator, but
  verify that on your Xcode version early rather than discovering it late.

The old repo's 181 Playwright checks do not port. `LiftKit` unit tests are the
replacement for the logic half; XCUITest covers flows if it earns its keep.
**Never weaken an assertion to make a suite go green** — if a test is wrong, fix
it deliberately and say so.
