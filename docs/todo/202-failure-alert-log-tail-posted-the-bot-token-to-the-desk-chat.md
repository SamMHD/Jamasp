---
id: 202
title: The 12 Oct jamasp-bot failure alert posted a journal tail containing the Telegram bot token to the desk chat, and that text now sits in the committed notify_log
status: open
opened: 2026-10-18
owner: unassigned
closed:
---

## What happened

`notify_log` id 314 (2026-10-12T13:20:15Z) is the `jamasp-alert@jamasp-bot`
notice fired by the deploy restart of PR #52. Its "last log lines" section
quotes two httpx INFO lines of the form
`POST https://api.telegram.org/bot<id>:<token>/getMe` — the full bot token,
in clear, delivered to the desk Telegram chat and stored in
`state/jamasp.db`, which every agent run commits. The token is therefore in
the repository history from the 12 Oct 15:00Z scan commit onward, and on
every clone/remote of it.

PR #53 (`fix(bot): keep the bot token out of the journal`, merged 12 Oct
13:19Z) stops httpx logging the URL, so later alerts do not carry it — the
13:20Z alert quoted lines written by the pre-fix process at 13:17–13:18Z.
Nothing in the alert path itself redacts: `jamasp-alert@` tails the journal
verbatim, and `notify` stores verbatim.

## Why it matters

Anyone with read access to the desk chat history, the repo, or any backup
of the DB holds the token until it is rotated. The alert path will leak the
next secret that reaches a journal line the same way (Cloudflare Access
JWTs in `jamasp-authd` logs, an API key in a traceback).

## Fix

1. **Rotate the bot token** (BotFather → `/revoke`), update the host's env
   file, restart `jamasp-bot`. A human step; the desk was told in the 18 Oct
   retro summary.
2. In the alert unit's log-tail step, redact `bot[0-9]+:[A-Za-z0-9_-]+`,
   `Bearer …`, `token=…`, `key=…` patterns before the text reaches
   `jamasp notify`; add a test with a fixture journal line.
3. Decide whether `notify_log` row 314 is scrubbed in place (the history
   keeps it regardless) — rotation makes the stored value worthless, which
   is the real fix; a scrub is cosmetic.

## Related

- todo-191 (authd alerts on every deliberate restart — the same alert fired
  for the same non-failure reason here, which is how the leak happened).
- todo-007 (alerts cannot say why) — the log-tail section was added to make
  alerts informative; this is its cost.
- PR #53, `jamasp/bot.py`, `ops/systemd/jamasp-alert@.service`.

Filed by the 18 Oct 2026 retro (analysis run; not fixed mid-run; the token
is deliberately not reproduced here).
