# Jamasp TODOs

A flat directory of outstanding, real dev items — not a wishlist, not a design
doc. One file per item. No index file; discover items by listing or grepping
the directory (see below).

## This is one of three queues — pick the right one

Jamasp records future work in three places, and putting an item in the wrong
one is how it gets lost:

| Queue | For | Consumed by |
|---|---|---|
| `docs/todo/` (here) | **code, config and ops gaps** — a parser to write, a source to wire, a unit to fix | a human or a dev session |
| `state/lessons-inbox.md` | **analysis lessons** — a bias to name, a rule to promote into the playbook | the weekly `/retro` |
| `jamasp wakeup add` | **an analysis run to do later** — read a statement once it publishes | the 5-minute dispatcher |

A retro or brief that finds a code gap should write it **here**, not only into
its report. The 2, 9 and 16 Aug 2026 retros each re-raised the same
`config/sources.yaml` gap in a Telegram line and nothing moved for three
weeks, because there was nowhere for a retro to file a dev task. That is the
hole this directory fills.

## When to create one vs. just fixing it

Fix it inline if you can, in the change you're already making. Create a file
instead when the fix:

- needs a decision that isn't yours (a new source, a threshold, anything the
  playbook or a human owns);
- needs access or evidence you don't have right now;
- is genuinely out of scope for the change in front of you and would bloat it;
- is a gap you're consciously deferring, not one you forgot about.

## Filename convention

```
NNN-kebab-case-slug.md
```

`NNN` is a zero-padded, sequential three-digit id. Find the next one with:

```sh
ls docs/todo/[0-9]*.md | grep -oE '[0-9]{3}' | sort -n | tail -1
```

IDs are never reused, even if an item is abandoned.

## Frontmatter

```yaml
---
id: 001
title: One-line summary of the item
status: open        # open | in-progress | done | abandoned
opened: 2026-08-17  # date this file was written
owner: unassigned   # who's actively working it, once someone is
closed:             # date it left open/in-progress
---
```

Files are never moved to a `done/` subdirectory and never deleted — the
`status` field changes and the file stays put, so links from a PR, a commit,
a report or a memory note stay valid and `git log <file>` remains the record
of how the item was resolved.

List open items (the `[0-9]*` glob matters — a bare `*.md` also matches this
README, whose frontmatter example contains a literal `status: open` line):

```sh
grep -l '^status: open' docs/todo/[0-9]*.md
```

Everything not closed:

```sh
grep -lE '^status: (open|in-progress)' docs/todo/[0-9]*.md
```

## Required sections

In this order. The bar: someone with no memory of how this was found should be
able to read the file and start work without asking a clarifying question.

- **Problem** — what's wrong, stated plainly.
- **Why it matters** — the real consequence of leaving it open. A cost, a risk,
  or an incident that already happened. Not "best practice."
- **Evidence** — what was actually observed: file paths and line numbers, query
  output, HTTP status codes, dates, run ids. What was checked and what it
  showed, never "probably." **State the negatives too** — the URLs that 404ed,
  the source that 403s from the host — so the next person doesn't re-probe
  them. If something relevant is unknown, say so rather than leaving a silent
  gap.
- **Fix** — what closing this would involve, concretely enough to start.
- **Done when** — the observable condition that means it's closed. Something
  checkable, not a feeling. "Abandoned with a reason" is a legitimate outcome
  and should be named here when the item might turn out not to be worth doing.

Optional: **Related** — specs, commits, PRs, playbook heuristics, memory notes.

## Verify before you file, and before you close

A todo asserting something is broken must have checked that it is broken, in
the same sitting, by running the thing. Two "dev tasks" carried by the retros
in Aug 2026 were phantoms — a calendar feed reported dark that was serving 21
events at the time, and a source gap justified by an event that predated the
archive. Both survived because a claim was restated instead of re-checked.

The same applies at close: fill `## Resolution` with what shipped and how you
confirmed **Done when** was met, not with "should be fixed now."

## Working an item

Set `status: in-progress` and `owner:` before starting; commit that alone if
the fix isn't happening in the same sitting. An item silently worked with no
status change is indistinguishable from one nobody is touching. If you learn
something material — scope grew, an assumption in **Evidence** was wrong —
append it to the file rather than silently redoing the investigation later.

## Closing or abandoning

- **Done:** `status: done`, fill `closed:`, append `## Resolution`.
- **Abandoned:** `status: abandoned`, fill `closed:`, append a `## Resolution`
  saying why. A deleted todo is indistinguishable from one never written; an
  abandoned one is a decision on the record.
