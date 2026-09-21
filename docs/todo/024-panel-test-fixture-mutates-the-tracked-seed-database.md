---
id: 024
title: The panel's test fixture builder writes to the tracked state/jamasp.db
status: open
opened: 2026-09-21
owner: unassigned
closed:
---

## Problem

`panel/scripts/build-fixture.mjs` resolves its database path as:

```js
const dbPath = path.join(root, "state", "jamasp.db");
```

That is the repository's own `state/jamasp.db` — a git-tracked file, the seed
the deploy skill relies on and the one CLAUDE.md rule 4 has every agent run
commit. Running the panel's test suite mutates it.

Observed across a single session of panel work: the file went from 249,856 to
405,504 bytes purely from test runs, showing as `M state/jamasp.db` in every
`git status` and turning up in four separate implementer reports as an
unexplained dirty file. Two agents independently paused to work out whether
they had caused it.

It also produces a real flake. When vitest runs test files in parallel and
more than one triggers the fixture builder against the same file, the second
fails with:

```
SqliteError: UNIQUE constraint failed: items.id
```

That was seen once during this work, bisected to the shared fixture rather
than to any code change, and did not reproduce afterwards — the signature of a
race, not a deterministic bug.

## Why it matters

Three separate costs, in rising order of seriousness:

1. **Noise.** Every panel test run dirties the working tree with a binary
   diff nobody intended, and each new contributor has to rediscover that it is
   harmless.
2. **A flaky suite.** An intermittent `UNIQUE constraint` failure that only
   appears under parallelism is the kind of failure people learn to re-run
   rather than investigate, which is how a real failure eventually gets
   ignored too.
3. **An accidental commit.** `state/jamasp.db` is a file agent runs are
   *instructed* to commit. A bloated, test-mutated copy can therefore ride
   into a commit on the next brief or scan without anyone deciding to include
   it — and on a branch that later merges to `live`, that overwrites the
   host's database seed with test data.

The third is the one worth fixing for. The first two are irritations; that one
is a data-loss path that runs on a timer.

## What to do

Point the fixture builder at a path outside version control — a temp
directory, or `panel/test/fixtures/` alongside the SQL it already keeps there —
and have the panel's tests resolve `DB_PATH` to that fixture rather than to
`JAMASP_ROOT/state/jamasp.db`. `panel/lib/paths.ts` already centralises the
path, so the override has one place to live.

Give each test file its own fixture copy, or build it once before the run
rather than lazily from whichever test gets there first; that is what removes
the race rather than hiding it.

Afterwards, confirm a full `npm test` leaves `git status` clean.
