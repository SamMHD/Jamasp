---
name: access-whitelist
description: Add or remove an email on the Jamasp panel's Cloudflare Access allow-list. Use when granting someone access to jamasp.mkagent.co, revoking it, or auditing who can reach the panel.
---

# Managing the panel's Access allow-list

The panel at `https://jamasp.mkagent.co` is gated by three layers. This
skill covers only the identity layer — who Cloudflare Access lets through.

| Layer | What it does |
|---|---|
| nftables on the origin | Accepts 80/443 only from Cloudflare ranges |
| **Cloudflare Access** | **The allow-list this skill edits** |
| nginx basic auth | Fallback only — used when the Access JWT is absent or unverifiable |

Adding someone here **is** enough. Since the Access-JWT work landed
(2026-08-09), a browser session that clears Access is admitted by the origin
on its JWT alone — there is no password to hand over. The basic auth
credential remains as an operator fallback for when the JWT path is
unavailable; it is not part of granting someone access.

## Identifiers

```
Account:      85799051dc45ac9a2add4892d13f4e58
Application:  c0dea932-2301-4102-8ebd-5949ccfa3b88   (jamasp.mkagent.co)
Auth domain:  mahdanian-saman-81.cloudflareaccess.com
IdP:          one-time PIN (email)
```

Allow-list as of 2026-09-25: `saman@mahdanian.xyz`,
`mahdanian.saman@gmail.com`, `kifepull@gmail.com`, `ali@mkagent.co`,
`mustafa@mkagent.co` and `ramin@mkagent.co` — one policy, "Desk operators"
(`b9740b80-0268-4522-972f-a37f20d8f84a`).

**There is a second application you usually do not touch.**
`d9e0dc1d-797c-4f73-8915-caa3214a6d3a` still gates the original hostname
`jamasp.mahdanian.xyz`, which now only 301s to the one above. Its own
"Desk operators" policy (`06f40e4a-449f-4d42-955d-1753442c8f4b`) carries the
same six emails so a bookmark on the old hostname still reaches the redirect
rather than a denial. Granting or revoking someone means editing **both**, or
the old bookmark keeps working after you thought you had cut them off — the
revocation case is the one that bites. Emails are stored lower-cased; Access
matches case-insensitively, but keeping one spelling makes the two lists
diffable.

**Do not trust that line — confirm with the read in step 1.** It is a snapshot
of mutable state living in a file that is not updated when the state changes.
The API is the only authority on who currently has access.

## Non-negotiables

1. **`decision` must stay `allow`.** A policy set to `bypass` returns 200s to
   everyone and silently disables Access entirely — it looks like it works.
2. **Exactly one policy on the application.** Multiple policies are evaluated
   together and make "who can get in" much harder to answer.
3. **Read before you write.** A `PUT` replaces the whole `include` array.
   Writing a payload built from memory silently drops everyone you forgot.
4. **Removing an email does not end an existing session.** Sessions last 24h.
   To cut someone off immediately, revoke sessions as well (below).

## Dashboard route

Cloudflare dashboard → **Zero Trust** → **Access** → **Applications** →
*Jamasp Panel* → **Policies** → edit the policy → adjust the *Emails* list →
**Save**.

## API route

Use the Cloudflare API MCP tool (`ToolSearch` for
`select:mcp__plugin_cloudflare_cloudflare-api__execute`).

### 1. Read the current policy

```js
async () => cloudflare.request({
  method: "GET",
  path: "/accounts/85799051dc45ac9a2add4892d13f4e58/access/apps/c0dea932-2301-4102-8ebd-5949ccfa3b88/policies",
})
```

Note the policy `id`, its `name`, and the existing `include` entries.

### 2. Write the merged list

Keep `decision: "allow"` and the existing name. Include **every** email that
should have access — the ones already there plus the new one.

```js
async () => cloudflare.request({
  method: "PUT",
  path: "/accounts/85799051dc45ac9a2add4892d13f4e58/access/apps/c0dea932-2301-4102-8ebd-5949ccfa3b88/policies/<POLICY_ID>",
  body: {
    name: "<existing name>",
    decision: "allow",
    include: [
      { email: { email: "mahdanian.saman@gmail.com" } },
      { email: { email: "newperson@example.com" } },
    ],
  },
})
```

To remove someone, write the same payload without their entry.

### 3. Verify

Read the policy back and confirm the `include` list and that `decision` is
still `allow`:

```js
async () => cloudflare.request({
  method: "GET",
  path: "/accounts/85799051dc45ac9a2add4892d13f4e58/access/apps/c0dea932-2301-4102-8ebd-5949ccfa3b88/policies",
})
```

Then confirm the panel is still gated — this must be a 302 to the auth
domain, never a 200:

```bash
curl -sSI https://jamasp.mkagent.co/ | head -3
```

A `200` here means Access is no longer intercepting; a `401` means Access was
bypassed and only basic auth is answering. Either is a fault — investigate
before walking away.

## Revoking access immediately

Removing the email stops future logins but leaves any live session working
for up to 24h. To cut it off now, revoke the user's Access sessions in the
dashboard: **Zero Trust** → **My Team** → **Users** → select the user →
**Revoke sessions**.

## Adding a non-human client

Do not add a shared human email for scripts. Cloudflare Access service tokens
exist for that and can be scoped to this application without touching the
human allow-list. None are configured today.
