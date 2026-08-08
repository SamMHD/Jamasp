---
name: access-whitelist
description: Add or remove an email on the Jamasp panel's Cloudflare Access allow-list. Use when granting someone access to jamasp.mahdanian.xyz, revoking it, or auditing who can reach the panel.
---

# Managing the panel's Access allow-list

The panel at `https://jamasp.mahdanian.xyz` is gated by three layers. This
skill covers only the identity layer — who Cloudflare Access lets through.

| Layer | What it does |
|---|---|
| nftables on the origin | Accepts 80/443 only from Cloudflare ranges |
| **Cloudflare Access** | **The allow-list this skill edits** |
| nginx basic auth | Fallback credential, user `desk` |

Adding someone here is **not** enough on its own: they also need the basic
auth password (in the operator's password manager). Both are required until
the Access-JWT work in
`docs/superpowers/specs/2026-08-09-access-jwt-origin-auth-design.md` lands.

## Identifiers

```
Account:      85799051dc45ac9a2add4892d13f4e58
Application:  d9e0dc1d-797c-4f73-8915-caa3214a6d3a   (jamasp.mahdanian.xyz)
Auth domain:  mahdanian-saman-81.cloudflareaccess.com
IdP:          one-time PIN (email)
```

Current allow-list: `mahdanian.saman@gmail.com`.

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
  path: "/accounts/85799051dc45ac9a2add4892d13f4e58/access/apps/d9e0dc1d-797c-4f73-8915-caa3214a6d3a/policies",
})
```

Note the policy `id`, its `name`, and the existing `include` entries.

### 2. Write the merged list

Keep `decision: "allow"` and the existing name. Include **every** email that
should have access — the ones already there plus the new one.

```js
async () => cloudflare.request({
  method: "PUT",
  path: "/accounts/85799051dc45ac9a2add4892d13f4e58/access/apps/d9e0dc1d-797c-4f73-8915-caa3214a6d3a/policies/<POLICY_ID>",
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
  path: "/accounts/85799051dc45ac9a2add4892d13f4e58/access/apps/d9e0dc1d-797c-4f73-8915-caa3214a6d3a/policies",
})
```

Then confirm the panel is still gated — this must be a 302 to the auth
domain, never a 200:

```bash
curl -sSI https://jamasp.mahdanian.xyz/ | head -3
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
