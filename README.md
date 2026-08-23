# GodMode

**No More Later.**

A push-up (and sit-up, and squat) challenge planner that runs on your phone. You tell it how
many you can do right now and what you want to get to. It builds the plan, counts you through
each workout, makes you repeat the days you miss, and keeps every rep you have ever done.

No account. No subscription. Nothing paywalled. Your data stays on hardware you control.

It exists because a challenge should not stop dead at six weeks, and because the history you
build up doing it should stay yours.

---

# Part 1 — For everyone

## Getting it on your phone

There is nothing to install from an app store. GodMode is a web page that behaves like an app
once you add it to your home screen.

### iPhone / iPad

1. Open **Safari** and go to the link you were sent. It has to be Safari — Chrome on iPhone
   cannot add proper home-screen apps.
2. Tap the **Share** button at the bottom of the screen (the square with an arrow pointing up).
3. Scroll down the list and tap **Add to Home Screen**.
4. Tap **Add** in the top-right corner.

You now have a GodMode icon on your home screen. Open it from there, not from Safari — that way
it runs full screen, with no browser bars, and it works without signal.

### Android

1. Open **Chrome** and go to the link.
2. Either tap the **Install** prompt that appears at the bottom, or tap the **⋮** menu in the
   top-right and choose **Install app** / **Add to Home screen**.
3. Confirm.

### On a computer

Just open the link in any modern browser. On a wide screen it lays itself out properly — tabs
along the top, your numbers and chart beside your session list — rather than sitting in a
phone-shaped column. The workout runner stays narrow on purpose: it is one big number you read
from the floor.

## Bringing your history across

If you already have months of this challenge logged elsewhere, you do not have to start from
zero.

**Step 1 — export a CSV from wherever your history is now.**

1. Open the app you have been training with.
2. Tap **Statistics** in the bottom bar.
3. Tap the small **CSV** icon in the top-right corner.
4. Save or send the file to yourself — AirDrop, email, WhatsApp to yourself, Files app,
   whatever is easiest. You just need to be able to find it again on your phone.

**Step 2 — put it into GodMode.**

1. Open GodMode. On first launch it offers **Bring your history across**.
2. Tap the file picker and choose the CSV you just saved.
3. You will see a summary: how many sessions it found, your total reps, how many planned days
   there were, and how many were repeats.
4. Check the **baseline max** it suggests. It works this out backwards from your very first
   session, and it is usually right — but if you remember the number you actually managed on
   your first test, type that instead.
5. Tap **Import my history**.

That is it. Every session and every repeat that the file could be read from is now in GodMode,
and it resumes at the day your history shows you had reached.

Two honest caveats, because "nothing is lost" is the whole promise and it should not be
overstated:

- **The import tells you what it skipped.** A row it cannot read — a malformed date, a set
  column that is not a whole number, gaps in the middle of the set columns — is reported by
  line number rather than guessed at. It will not round `7.6` up to `8` or quietly renumber
  your sets to close a gap. Sessions after a skipped row still import, and a day proven
  complete by later history is still marked complete.
- **Check the day it resumes on.** The last session in your file is judged against *our* target
  for that day, and our interior curve will not match every other version of this challenge
  exactly — see [How the numbers work](#how-the-numbers-work). If your history had already moved
  you on and GodMode has not, the manual advance in Settings fixes it.

### If you have never done the challenge

Choose **Take a max test** instead. Do one honest set of push-ups: rested, good form, stop when
you stop. Enter that number, pick what you want to get to, and GodMode builds your plan.

## Using it day to day

**Today** shows the session you owe. Something like:

```
Week 6 · Day 3                    205
37   47   37   33   51+       reps to pass
```

Five sets. Do 37, rest, 47, rest, 37, rest, 33, rest, then as many as you can manage on the
last one — at least 51. Tap **Start** and it counts you through, running the rest timer between
sets and beeping when it is time to go again.

The rest timer talks to you, because mid-set your phone is on the floor and you are not looking
at it: a soft tone at **ten seconds left**, then a click on each of the **last five**, then the
two-tone chime that means go. The clock turns amber, then teal, and beats once a second over the
last five. You can add or take 15 seconds at any point, or skip the rest entirely.

If you tap a number wrong, fix it at the end — the review screen lets you correct every set
before you save.

**You have to hit the total to move on.** If the plan says 205 and you do 202, that day comes
round again. That is the entire engine of the thing: it is why you go from 18 push-ups to a
hundred instead of plateauing at whatever felt comfortable.

### When you cannot manage the full session

Tap **Adjust** before you start. Two different things you can do:

- **Move reps between sets.** Same total, different shape. Maybe 40·40·40·40·45 suits you
  better than 37·47·37·33·51 today. This changes nothing about passing.
- **Change the total.** An easier day when you are ill, travelling, or wrecked — or a harder one
  when you feel good.

An easier day still counts. It goes in your history, your reps, your time, your streak. It just
does not move you on to the next day, because you have not done the next day's work yet. The app
calls that a **deload**, not a failure.

If you get properly stuck on one day, after a few attempts GodMode offers to move you on anyway.
It records that you skipped, so your numbers stay honest, but it stops blocking you.

### After the six weeks

When you finish the last day, GodMode does not just congratulate you and stop. It asks you to
**test your max again**, then set a new target, and builds the next block. Your whole history
carries over — the chart keeps climbing across every block you ever do.

You can also set the new target equal to your current max, which gives you a hold-steady block
rather than a climb.

## More than one exercise

Push-ups are not the only thing you can count. **Settings → Add a workout** creates another one
with its own plan and its own history — sit-ups, squats, pull-ups, dips, whatever. If you have
history for it in a CSV, you can import that too, exactly the same way.

Once you have more than one, a row of names appears under the GODMODE wordmark. Tap one to switch.
Everything below it — today's session, the chart, the totals — belongs to whichever one you picked.

Totals are **per exercise**, never added together: 3000 push-ups and 400 pull-ups are two facts,
not one number.

One honest limitation. The percentages were worked out from push-up-scale numbers. If you start
an exercise at four or five reps, the early sets come out very blunt — `2 · 2 · 2 · 2 · 3`. It
works, and the app tells you when you are in that territory, but it is not tuned for it yet.

## Your numbers

**History** shows three things that are deliberately kept apart, because they are not the same
achievement:

| | What it means |
|---|---|
| **Streak** | Sessions in a row where you kept the rhythm |
| **Compliance** | How often you actually hit the prescribed number |
| **Progress** | How far through the plan you are |

**Streak counts sessions, not calendar days**, and that distinction matters more than it sounds.
A three-day-a-week plan has rest days built into it. Counting consecutive *days* would score
someone who never missed a single session at "1 day, best 1 day" forever — it would punish
following the plan. So a session counts toward your streak as long as it lands within the spacing
your plan expects, plus a day of slack. Disappear for a week and it breaks, which is the thing
actually worth knowing.

You can deload every session and keep a perfect streak. That is fine — showing up matters — but
it should not look like you are hitting your numbers, so it doesn't.

The chart has two views, and they answer different questions.

**Per session** — the default — is one point per workout: what you did that day against what that
day asked for. This is the one that shows the shape of your training. Every repeat, every deload,
every plateau is visible, and coloured dots mark them.

**Running total** adds everything up as you go. Useful for "how much work have I actually done",
but it can only ever climb, so it is smooth no matter how uneven the sessions underneath were.
Your line normally sits *above* the plan's here, because a repeated day is extra work the plan
only counts once.

If the running total looks featureless, that is not a bug — a cumulative curve cannot show
variation. Switch to per session.

**Calories** are a rough estimate, not a measurement. Set your bodyweight in Settings and it
works out roughly how much energy the work took. It is shown because there is no reason to hide
it, but treat it as a ballpark.

## Where your data lives

Your training lives in one SQLite file on **your own server** — a file you can see, copy and back
up. No account, nobody's database but yours, and the same history on your laptop and your phone.

You sign in once with a token the server prints (`npm run token`). It is exchanged for a session
cookie your browser holds and JavaScript cannot read.

**The one thing that still lives in the browser** is a workout you are in the middle of, and a
workout you finished with no connection. The second one matters: it sits in this browser until
the server takes it, and iOS can clear storage for web apps you have not opened in a while. The
app tells you when anything is waiting — **do not reinstall or clear site data while it is**.
Everything else is on the server; clearing the browser costs you nothing.

## Backups — please read this one

Every so often, go to **Settings → Export…**. It saves one file. Put it somewhere that is not
your server — cloud drive, email to yourself, anywhere. GodMode will nag you about this. Let it.

Restoring one is done on the server rather than in the app, because it replaces everything:

```sh
npm run import-backup -- backup.json --target godmode.sqlite --dry-run   # rehearse
npm run import-backup -- backup.json --target godmode.sqlite             # do it
```

It validates every field of every record, builds a **new** database in a temporary file, verifies
it with SQLite's own integrity and foreign-key checks plus a record-by-record comparison, and
only then puts it in place — keeping a copy of whatever was there before. A backup that is
damaged, truncated, or missing a section is refused outright with nothing changed.

You can also export a **CSV** at any time, in the same format it imports. Nothing here is
locked in. Two things to know about it: the **JSON backup is the one that restores** — the CSV is
for reading your data in a spreadsheet or taking it elsewhere — and a session that never matched
a planned day cannot currently come back in through CSV, because it exports without a week/day
and the importer will not accept a row it cannot place. The JSON backup carries everything.

## Stuck? Ask an AI

If you would rather be walked through it than read this, paste the app's link into ChatGPT,
Claude, or whatever you use, and ask it to help you install it. The site serves a file at
**`/llms.txt`** written specifically for that — the install steps, the CSV export path, the
vocabulary, and the mistakes people actually make. Assistants read it automatically.

---

# Part 2 — How it works

This part explains the actual mechanism. You do not need it to use the app, but it is the
interesting bit.

## The plan

Every session prescribes five sets, as fixed percentages of an *estimated max*:

| Set | Share of max | Character |
|-----|--------------|-----------|
| 1 | 37% | medium |
| 2 | 47% | **big** |
| 3 | 37% | medium |
| 4 | 33% | *small* |
| 5 | 51%, open-ended | **biggest** |

Two things fall out of that table.

**It adds up to 205%.** That is why a goal of 100 produces a final session of 205 reps rather
than 100. You are never asked for 100 in one go — the last set of the last day asks for 51 or
more, on the theory that a hundred is then within reach. This is the single most confusing thing
about the challenge, and it is just this.

**Set 4 dips below sets 1 and 3 on purpose**, so you have something left for the open-ended set.
Set 5 is the only one that is uncapped, it is the largest, and everything before it is
scaffolding.

The estimated max climbs geometrically from your baseline to your goal across the block — about
10.6% per session for a six-week, three-day-a-week block starting at 18.

```
M(n) = baseline × (goal / baseline) ^ ((n − 1) / (sessions − 1))
set_i = round(M(n) × coefficient_i)
```

## How the numbers work

A real 29-session export is committed in `example/`, so every claim below can be checked against
data rather than taken on trust.

The table is **exact at both ends** of a six-week block:

| | Estimated max | Sets | Total |
|---|---|---|---|
| First day | 18 | `7 · 8 · 7 · 6 · 9+` | 37 |
| Last day | 100 | `37 · 47 · 37 · 33 · 51+` | 205 |

Both match the reference data to the rep. At a goal of 100, the prescribed sets literally *are*
the percentages.

**The curve between those two endpoints is ours.** It reproduces 5 of the 18 reference sessions
exactly and runs high on the early ones. GodMode uses an explicit, inspectable, adjustable
formula rather than a lookup table, so you can see exactly what it will ask of you and when.

## Three numbers that are not the same thing

This one matters, and getting it wrong would quietly corrupt every future block:

- **Goal** — an input to the plan. Setting a goal of 100 says *"build the last day from 100"*.
  It makes no claim about what you can do.
- **Best set** — reps on an open-ended set. A real measurement, but a tired one: 48 reps at the
  end of a session that already contained 154 is not the same as 48 fresh.
- **Max test** — one rested set to failure. The only honest basis for building a new plan.

Finishing a "100 push-ups" challenge does not mean you can do 100 push-ups in one set — the
challenge is built *from* that number, not *to* it. So when a block ends, GodMode asks you to
retest rather than assuming, and every baseline it stores records where the number came from —
tested, typed in, imported, or estimated.

## Passing, and the five outcomes

A session passes when **the sum of your actual reps meets or beats the target total.** Not
per-set — the total. That is verified from the source data: one session came in at 55 against
56, with the first four sets identical to the successful retry, and it repeated.

Every attempt gets exactly one outcome:

| Outcome | Counts in history | Moves you on |
|---|---|---|
| Completed as planned | yes | yes |
| Scaled up | yes | yes |
| **Deload** (you lowered the total) | yes | **no** |
| Missed | yes | no |
| Moved on anyway | yes | yes — recorded as a skip |

"Counts" and "moves you on" being separate columns is what lets a deload be honest work without
being a free pass.

## Rest

Rest grows with the size of the session — roughly 30 seconds at the start of a block, about two
and a half minutes by the end.

This is a sensible default rather than a measurement: a CSV export bundles work and rest into a
single duration per session, so the two cannot be separated from it. Override it with one fixed
number in Settings if you prefer.

## Calories

Calories are shown, never hidden. Imported kcal values are kept as they arrived — they are not
reproducible from any simple formula (37 reps → 13 kcal, but 44 reps → 9), which suggests they
came from a watch or HealthKit rather than arithmetic. For everything else GodMode computes its
own, transparently:

```
kcal ≈ reps × bodyweight_kg × 0.003
```

That comes from lifting roughly 65% of bodyweight through about 0.4 m at around 22% metabolic
efficiency — about 0.25 kcal per rep at 80 kg. Bodyweight is the only body measurement needed;
height and age add nothing worth having for this movement.

Imported calorie values are kept separate from computed ones and never mixed, and each estimate
records which version of the formula produced it, so changing the formula later cannot silently
rewrite your history.

## What it does not do

Deliberately absent:

- **Exercise pictures, animations, demo videos.** An exercise is a label. This was the single
  biggest cost in the project and cutting it is why the app exists at all.
- **Accounts, sync, a server.** All three would break the one property that matters most.
- **A leaderboard.** Comparing with the group is a share card you paste into the chat, and it is
  not built yet.
- **Combined totals across exercises.** Each workout keeps its own numbers, on purpose.
- **Other languages.** English only. The *importer* handles other languages; the interface
  doesn't.

---

# Part 3 — For developers

## Running it

There are two processes now: the API server that owns the data, and Vite.

```sh
npm install

# Terminal 1 — the server. Generates a secret on first run, serves /api and dist/.
npm run serve                  # http://localhost:8787
npm run token                  # print that secret, to paste into the app's sign-in screen

# Terminal 2 — the dev client, with /api proxied to the server above.
npm run dev                    # http://localhost:5173

npm test
npm run typecheck
npm run build                  # production bundle + service worker into dist/
```

**Open `http://localhost:5173` for development and `http://localhost:8787` for the built app.**
Both work; nothing else does without TLS. The session cookie is `Secure`, and browsers refuse a
`Secure` cookie over plain HTTP everywhere except loopback — so sign-in fails on a LAN address by
design rather than quietly sending the secret in clear text. `server/DEPLOY.md` has the rest.

Vite proxies `/api` to `127.0.0.1:8787` (`GODMODE_SERVER_PORT` to change it) so the browser sees
**one origin** in development, exactly as it does in production. That is what keeps
`SameSite=Strict` a complete CSRF defence; splitting the two across origins would require a CSRF
token in the same change.

## Deploying it

`npm run start` builds the client and serves it and the API from one listener. It needs a data
directory and a token, both outside the repository, and **TLS the moment it is not on
localhost**. The four things a deployment has to get right — TLS, one origin, the Node version,
and where the database file lives — are in `server/DEPLOY.md`.

## Stack

Vite · TypeScript (strict, `exactOptionalPropertyTypes`) · React · Tailwind · Vitest · a Node
`node:sqlite` server with no framework. IndexedDB via `idb` survives as a write-ahead buffer
only: the in-progress workout and the outbox of unsent ones. No charting library, no component
library, no ORM.

## Layout

```
src/core/         pure domain logic — no DOM, no storage, no React
  types.ts          domain types and the three-different-numbers distinction
  rounding.ts       explicitly pinned rounding (see below)
  contracts.ts      the three pluggable seams
  stats.ts          totals, streaks, metrics, cumulative series
  patterns/         percentage-ramp: the progression
  policies/         rest and evaluation policies
src/api/          the typed API client, snapshot selectors, the outbox drainer
src/db/           record builders, plus the IndexedDB draft + outbox buffer
src/import/       the four-stage CSV pipeline + mapping profiles
src/data/         backup and CSV export
server/           the API and the SQLite file it owns — see server/PERSISTENCE.md
src/ui/           screens and a small hand-rolled component kit
  cues.ts           Web Audio rest-timer cues + the pure cue schedule
  NewWorkout.tsx    creation forms, shared by first run and add-another
  Chart.tsx         per-session and cumulative SVG charts
public/llms.txt   install + setup guide written for AI assistants, served at /llms.txt
```

`src/core/` is where the value is. It has no imports from the rest of the app and is heavily
tested.

## The three seams

The owner asked for flexibility across workout patterns, so there are three narrow, versioned
extension points. **One implementation of each ships** — this is a seam, not a framework.

```ts
interface ProgramPattern<P, S> {
  id: string
  version: number
  plannedSessionCount(params: P): number | undefined
  initialState(params: P): S
  next(input: { params, state, history }): { slot, nextState, decision } | null
}
```

`next()` is **incremental** rather than returning the whole plan. Deterministic patterns lose
nothing — `materialize()` runs it in a loop — but an adaptive pattern (RPE-driven, recalibrating
from your open-ended set, or open-ended with no known end) is not blocked by an interface that
assumes every plan is knowable up front.

`RestPolicy` exists so patterns do not each reimplement clamping and rounding. `EvaluationPolicy`
returns **separate `satisfied` and `advances` flags**, which is precisely what makes "a deload
counts but does not advance" expressible rather than a special case bolted on later.

## Data model notes

Four decisions that would be expensive to change later:

- **One planned day can have many workouts.** Repeats mean a single day accumulates attempts.
  Conflating the plan with the log is the mistake that forces a migration.
- **Adjustments live on the workout, not the day.** Attempt 1 might redistribute and attempt 2
  deload; a single override field on the day would destroy the record of why each attempt passed
  or failed.
- **Set targets are a variable-length array, not five columns.** In a document store that is the
  child-row requirement satisfied for free, and it makes a different set count a feature rather
  than a migration.
- **A workout's planned-day link is optional.** An imported session that cannot be matched is
  kept unlinked rather than force-fitted onto the wrong day.

## Rounding

`src/core/rounding.ts` pins one rule — half away from zero, on the decimal value — and it is not
fussiness:

```
Math.round(-2.5)  === -2     // rounds toward +Infinity
roundHalfUp(-2.5) === -3
1.005 * 100       === 100.49999999999999   // so naive rounding gives 100, not 101
```

The set ordering is sensitive at `.5` boundaries, so an unpinned rule changes prescriptions.

## Import pipeline

```
raw text → parse → rows → map (profile) → canonical JSON → validate → commit
```

The canonical JSON in the middle is the real interchange format: it is what exports produce, what
test fixtures are written in, and what you would send when reporting an import bug.

**Columns are addressed positionally, never by header name.** The source export contains
**two columns both named `Zeit`** — index 3 is the challenge length (`"6 Wochen"`), index 6 is the
session duration (`"06:31"`). Building a dictionary from the header collapses 14 columns to 13 and
silently loses one. There is a test that demonstrates exactly that failure.

Because mapping is positional, a translated export does **not** need its own profile — only a
different *value* format does, which in practice means the date. Date format is detected by
trying candidates and preferring the one that yields chronological order, and it reports genuine
ambiguity rather than guessing silently.

Imported rows carry **actual reps only**. Prescribed targets are never manufactured from them —
and "never" has teeth: a session that reconciles to no plan slot is stored with **no**
`effectiveTarget` at all rather than borrowing its own actuals. Absent means unknown. An earlier
version defaulted the field to `actual`, which recorded that the user had been told to do exactly
what they did, and made every unreconciled session read as a perfect hit forever.

**Validation refuses rather than repairs.** Each of these was once a silent rewrite:

| Input | Old behaviour | Now |
|---|---|---|
| A set logged as `0` | dropped, renumbering later sets | kept, position preserved |
| `7.6` reps | rounded to `8` | row rejected, reported by line |
| A negative set value | dropped | row rejected |
| Blank *between* filled set columns | closed up silently | row rejected — set order is unknowable |
| `31.2.2026` | passed a `day <= 31` check, became 3 March | row rejected |
| Duration `05:99` | read as 6m39s | ignored |

The whole import commits in **one transaction**. It previously wrote the exercise, then the
challenge and slots, then each workout, then the slot statuses — so a failure part-way through
left an orphan exercise, or a challenge holding half the history with nothing recording that it
was incomplete.

### One subtlety worth knowing

When importing, GodMode does *not* judge your old sessions against its own targets. Its
early-week curve runs higher, so doing that would mark finished weeks as failed and send you back
to week 1.

Instead it reads the decisions already recorded in the data: a day was repeated until it was
passed, so history on a later day proves the earlier days passed. Only the furthest day you
reached is genuinely undecided, and there the real pass rule applies. On the reference file that
yields days 1–17 complete and day 18 still open — which is the true state, because that session
came in at 202 against 205.

## Tests

```sh
npm test
```

196 tests, all pure or against a fake IndexedDB. Notable ones:

- Both verified reference cards reproduce exactly.
- The set ordering holds for **every integer max from 1 to 200** — non-strictly, with regression
  guards proving a *strict* version is unsatisfiable (`M=14 → 5,7,5,5,7`, `M=20 → 7,9,7,7,10`).
  A strict assertion would have failed on session 2 of the very data the model came from.
- The rounding boundary cases above.
- The real CSV, asserted down to individual sessions. It is one real person's activity history,
  committed deliberately so the import claims are reproducible by anyone who clones. Those blocks
  skip if the file is removed, and a synthetic fixture covers the structure, so the suite is green
  either way.
- **Restore refusing to destroy data.** A file containing only
  `{"format":"godmode-backup","formatVersion":1}` used to clear every store and report success,
  because each collection was read as `?? []`. Each rejection case now asserts that the existing
  history is *still there* afterwards, which is the property that actually matters.
- **The v1 → v2 database migration, from a populated v1 database.** The upgrade callback created
  every store unconditionally, so the first version bump would have thrown `ConstraintError`
  against existing stores, aborted the upgrade, and left the app unable to open the database at
  all — on a device holding the only copy.
- Each import-validation refusal in the table above, paired with a good row, so the test proves
  the bad row specifically was caught rather than the whole file being thrown away.
- One test **pins a limitation rather than hiding it**: a session with no plan slot cannot
  round-trip through CSV, because it exports blank week/day that the importer rejects. When that
  is fixed the test fails and gets updated, instead of the gap being quietly forgotten.
- The cue schedule, including the `<= 5` boundary. A one-beep-off error is genuinely hard to
  notice by ear, so it gets an assertion rather than a listen.
- `resolveSelectedChallenge` falling back when the stored selection names a challenge that was
  ended or never existed here. Without the fall-back that is an empty screen over intact data.
- `sessionSeries` against `cumulativeSeries` on the same history, asserting the per-session line
  is *not* monotonic where the cumulative one is. That non-monotonicity is the entire point of
  the chart, so it is pinned.

## Status and what's next

Everything described above is built and working: plan generation, the runner, history and
charts, CSV import and export, and the server.

Planned, not built:

- **On-device rep counting** with the camera, using MediaPipe pose detection in the browser — plus
  form checks for hip sag and elbow depth. Browser-side, not Python: Python cannot run on an
  iPhone, and a phone propped against a wall is the actual use case. The runner already has a seam
  for it.
- **A share card** to paste into the group chat. No backend.
- **User-defined set counts** (4 or 6). Storage already supports it; the prescriptions for those
  counts would be invented rather than derived, so they wait for a real need.
- **A low-rep table** for exercises like pull-ups. At a baseline of 5 the current one yields
  `2 2 2 2 3` — valid, and it satisfies the ordering invariant, but far too coarse to be a good
  plan. The app warns when you are in that range rather than pretending otherwise.
- **Combined totals** across exercises, if anyone actually asks for them.

## Licence

AGPL-3.0-or-later. See `LICENSE`. Fork it, run it, change it — derivatives stay open, including
hosted ones.
