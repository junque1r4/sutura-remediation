# ADR 0001: Sutura is single-tenant

- Status: Accepted
- Date: 2026-06-05

## Context

Sutura runs as a single deployment serving exactly one organization. Despite this,
several code paths accept an org identity from client-controlled input -- an
`x-org-id` request header on the webhook routes, an `?orgId=` query parameter on the
`/internal` proxy routes, a `DEFAULT_ORG_ID` environment variable, and a
`resolveOrgId(req)` helper that reads the org from the incoming request. Trusting
client-supplied org identity is both a security hazard (a forged value could reach data
across a tenant boundary) and dead complexity, because there is only ever one org.

## Decision

Sutura is **single-tenant**. We adopt the invariant:

> **The org is never read from client input.**

The org is a singleton resolved **server-side** (from the database / a server-side
constant), never from a request header, query parameter, or body. RBAC and memberships
remain in force: removing org *selection* does not remove *authorization*.

### Removed

- The `x-org-id` header handling on the webhook routes.
- The `?orgId=` query parameter on the `/internal` proxy routes.
- The `DEFAULT_ORG_ID` environment variable.
- The `resolveOrgId(req)` helper (any request-trusting org resolution).

### Explicitly deferred (NOT part of this work)

These are intentionally left in place to keep the change small and reversible:

- Collapsing the `org_id` foreign-key columns out of the schema.
- Removing `active_org_id` from `user_sessions`.
- Removing any org-switch UI.

These can be revisited later; the security-critical invariant above does not depend on
them.

## Consequences

- Client requests can no longer influence which org's data is touched; the org is
  resolved server-side as a singleton.
- RBAC / membership checks are unaffected and still required on every route (see
  `docs/security-guidelines.md`, rule 4).
- The deferred items leave some now-constant plumbing (`org_id` columns,
  `active_org_id`) in the schema. This is acceptable: those columns are populated
  server-side and never trusted from the client.
