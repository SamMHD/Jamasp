# Vendored Superpowers skills

The [Superpowers](https://github.com/obra/superpowers) skill set is vendored
into this repo at `.claude/skills/` so it is available to *every* session that
works on Jamasp — including headless runs on the deployment host and remote
web sessions — without anyone having to install the Claude Code plugin first.

The plans and specs under `docs/superpowers/plans/` and
`docs/superpowers/specs/` were produced with these skills; keeping the skills
alongside them means follow-up work uses the same methodology.

## Provenance

| | |
|---|---|
| Upstream | https://github.com/obra/superpowers |
| Version | 6.2.0 |
| Commit | `44c9b2d6e889982ac18c27d05a19fefe335194e1` (2026-07-27) |
| License | MIT — see `.claude/skills/SUPERPOWERS-LICENSE` |
| Vendored | 2026-08-01 |

## What was installed

The 14 skill directories from upstream `skills/`:

`brainstorming`, `dispatching-parallel-agents`, `executing-plans`,
`finishing-a-development-branch`, `receiving-code-review`,
`requesting-code-review`, `subagent-driven-development`,
`systematic-debugging`, `test-driven-development`, `using-git-worktrees`,
`using-superpowers`, `verification-before-completion`, `writing-plans`,
`writing-skills`.

They sit flat in `.claude/skills/` next to Jamasp's own operational skills
(`brief`, `scan`, `deepdive`, `retro`, `deploy`). No names collide.

## Local modifications

One, applied mechanically:

- **Dropped the `superpowers:` namespace prefix** from cross-skill references
  (26 occurrences across 10 files). Upstream ships as a Claude Code *plugin*,
  where skills resolve as `superpowers:test-driven-development`. Vendored as
  project skills they resolve by bare name, so the prefixed form would fail to
  load. Skill content is otherwise byte-identical to upstream.

Upstream's `hooks/` (a `SessionStart` hook that injects the
`using-superpowers` bootstrap) was **not** installed. On this repo that hook
would fire on every Jamasp timer run — brief, scan, retro, dispatched wakeups
— and push a software-development methodology into runs that are doing market
analysis. The skills still auto-trigger from their descriptions during
development work, which is what we want here.

## Updating

```bash
git clone --depth 1 https://github.com/obra/superpowers.git /tmp/superpowers
rm -rf .claude/skills/{brainstorming,dispatching-parallel-agents,executing-plans,\
finishing-a-development-branch,receiving-code-review,requesting-code-review,\
subagent-driven-development,systematic-debugging,test-driven-development,\
using-git-worktrees,using-superpowers,verification-before-completion,\
writing-plans,writing-skills}
cp -R /tmp/superpowers/skills/. .claude/skills/
cp /tmp/superpowers/LICENSE .claude/skills/SUPERPOWERS-LICENSE
grep -rl 'superpowers:' .claude/skills | xargs sed -i 's/superpowers://g'
```

Then update the provenance table above with the new version and commit.
