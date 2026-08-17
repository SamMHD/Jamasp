---
name: todos
description: Record, work and close outstanding Jamasp dev items in docs/todo/. Use whenever someone asks about project todos or outstanding work, wants to log a known code/config/ops gap or deferred fix for later, wants to pick up an existing item, or wants to mark one resolved or abandoned. Also use when a brief, scan or retro turns up a code gap it cannot fix itself.
---

# Jamasp TODOs

The system lives in `docs/todo/`. The full convention — filenames, frontmatter,
required sections, the exact grep commands — is in `docs/todo/README.md`. Read
that before creating or editing a file; it is not repeated here.

## Which queue an item belongs in

This is the decision to get right, because the wrong queue means the item is
never seen again:

- **`docs/todo/`** — code, config and ops gaps. A parser to write, a source to
  wire, a systemd unit to fix, a threshold to revisit.
- **`state/lessons-inbox.md`** — analysis lessons for the weekly `/retro`: a
  bias to name, a rule to promote into `state/playbook.md`. Never edit
  `state/playbook.md` directly from any other run; that file is `/retro`'s.
- **`jamasp wakeup add`** — an analysis run to perform later, e.g. reading a
  statement once it publishes.

An analysis run that finds a **code** gap files it here and mentions it in its
report. It does not stop to fix Jamasp's code mid-run.

## Why this directory exists

The 2, 9 and 16 Aug 2026 retros each re-raised the same `config/sources.yaml`
gap, in a Telegram line, and nothing moved for three weeks — a retro had no way
to file a dev task. If you are about to write "re-raised again" anywhere, write
a todo file instead.

## Creating one

1. Next id: `ls docs/todo/[0-9]*.md | grep -oE '[0-9]{3}' | sort -n | tail -1`
2. Write `docs/todo/NNN-kebab-slug.md` with the frontmatter and all five
   required sections from `docs/todo/README.md`.
3. **Verify the problem in the same sitting.** Run the command, query the DB,
   probe the URL. Two of the dev tasks the retros carried in Aug 2026 were
   phantoms that survived because a claim was restated rather than re-checked.
4. **Record the negatives in Evidence** — the URLs that 404ed, the host that
   403s, the source that parses but extracts nothing. Half of a todo's value is
   stopping the next person re-probing dead ends.
5. Link related specs, commits and playbook heuristics under `## Related`.

## Working one

Set `status: in-progress` and `owner:` before starting, committing that alone
if the fix isn't happening now. Append anything material you learn to the file
rather than silently re-deriving it later.

## Closing one

`status: done`, fill `closed:`, append `## Resolution` with what shipped and
how you confirmed **Done when** — verified, not assumed. If it turns out not
worth doing, `status: abandoned` with a reason. Never delete or move a todo
file: a deleted one is indistinguishable from one never written.

## Don't restate what other docs own

Cross-link instead of re-explaining:

- source research and dead ends → `docs/future-sources.md`
- designs and plans → `docs/superpowers/specs/`, `docs/superpowers/plans/`
- host, units and runbook → `.claude/skills/deploy/SKILL.md`
- failure alerting → `.claude/skills/alerting/SKILL.md`
