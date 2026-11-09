# Sutura Security Guidelines

These are the binding security rules for the Sutura monorepo (Next.js dashboard at
`apps/dashboard`, Express backend at `packages/backend`, shared code in
`packages/common`). They are derived from the security-remediation audit and apply to
all new and modified code. Where a rule has a "Do" / "Don't" pair, follow the "Do".

Sutura is **single-tenant**. Several rules below depend on that invariant; see
[ADR 0001](./adr/0001-single-tenant.md).

---

## 1. Integration credentials in cookies

Any integration credential (Snyk PAT, Anthropic key, GitHub installation data, etc.)
stored in a cookie MUST be encrypted with the shared AES-256-GCM helpers in
`apps/dashboard/src/lib/crypto.ts` (`encryptJson` / `decryptJson`). Never serialize a
credential to a cookie with `JSON.stringify` or store it as a raw string.

The helpers derive the key as `sha256(secret)` and emit the format `iv:ct:authTag`
(hex). `decryptJson` returns `null` on a tampered or malformed payload, so callers must
handle `null` (treat it as "not connected" / re-auth).

Do:

```ts
import { encryptJson, decryptJson } from '@/lib/crypto';
import { getCookieSecret } from '@/lib/config'; // single config module, see rule 2

const secret = getCookieSecret();
cookieStore.set('snyk_conn', encryptJson({ token, snykOrgId }, secret), {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
});

// reading
const raw = cookieStore.get('snyk_conn')?.value;
const conn = raw ? decryptJson<SnykConn>(raw, secret) : null;
if (!conn) return notConnected();
```

Don't:

```ts
// Credential in cleartext, tamper-able, readable by anyone with the cookie value.
cookieStore.set('snyk_conn', JSON.stringify({ token }));
const conn = JSON.parse(cookieStore.get('snyk_conn')?.value ?? '{}');
```

---

## 2. Secret resolution (single config module, fail-fast)

All secrets and required environment variables MUST be resolved through a single config
module. No call site reads `process.env.X` directly, and no secret has a hardcoded
fallback (`process.env.SECRET ?? 'dev-secret'` is forbidden). The config module
validates required secrets at boot and throws (fail-fast) if any are missing.

Do:

```ts
// config.ts -- the only place that touches process.env for secrets
function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

export const config = {
  cookieSecret: required('COOKIE_SECRET'),
  jwtSecret: required('JWT_SECRET'),
};
```

Don't:

```ts
// Hardcoded fallback ships a known secret to production; scattered env reads
// mean a missing secret is discovered at request time, not at boot.
const secret = process.env.COOKIE_SECRET ?? 'dev-secret';
```

---

## 3. Org identity is server-resolved (single-tenant)

Sutura is single-tenant. The org identity is a server-resolved singleton. It MUST NEVER
be read from client-controlled input: not from a request header (`x-org-id`), not from a
query parameter (`?orgId=`), and not from a request body. There is no
`DEFAULT_ORG_ID` env var and no `resolveOrgId(req)` helper that trusts the request.

Do:

```ts
// Resolve the singleton org server-side (e.g. from the DB / a server constant).
const orgId = await getCurrentOrg(); // no request argument
```

Don't:

```ts
// Client can forge the org and reach data it should never see.
const orgId = req.headers['x-org-id'] ?? req.query.orgId ?? req.body.orgId;
```

RBAC and memberships still apply (see rule 4): single-tenant removes org *selection*, not
authorization.

---

## 4. Every API route is authorization-guarded

Every dashboard and backend API route MUST be guarded by a permission/membership check.
Use the existing helpers -- `requirePermission` / `requireMembership`, or the
`withPermission` / `withSession` higher-order wrappers. Do not hand-roll auth checks and
do not ship an unguarded route "temporarily".

Do:

```ts
export const POST = withPermission('findings:write', async (req, ctx) => {
  // ctx.session is guaranteed present and authorized here
});
```

Don't:

```ts
// No guard: any caller (authenticated or not) can hit this.
export async function POST(req: Request) {
  return doSensitiveThing(await req.json());
}
```

---

## 5. Sensitive data is redacted and capped before persistence

Prompts, model diffs, and logs frequently contain secrets, tokens, or large payloads.
They MUST NOT be persisted (DB columns, log lines, job records) as raw, unbounded text.
Redact known secret shapes and cap the stored length before writing.

Do:

```ts
import { redactSecrets } from '@sutura/common';

const MAX = 8_000;
const safe = redactSecrets(rawPrompt).slice(0, MAX);
await db.insert({ prompt: safe });
```

Don't:

```ts
// Stores API keys / tokens that appeared in the prompt, unbounded.
await db.insert({ prompt: rawPrompt });
logger.info(rawPrompt);
```

---

## 6. Secrets never travel in cleartext through Redis job payloads

BullMQ job payloads land in Redis (and Redis dumps / logs). Secrets MUST NOT be placed
in a job payload as cleartext. Pass a reference (e.g. a connection id the worker resolves
server-side) or an encrypted blob, and decrypt only inside the worker.

Do:

```ts
// Enqueue a reference; the worker resolves the credential from the DB.
await queue.add('scan', { findingId, connectionId });
```

Don't:

```ts
// The raw PAT is now sitting in Redis in cleartext.
await queue.add('scan', { findingId, snykToken: 'snyk-pat-...' });
```

---

## 7. Client cache (localStorage / sessionStorage) hygiene

Anything cached in `localStorage` / `sessionStorage` MUST have a TTL and a size guard,
and MUST be cleared on logout. Never cache credentials or full sensitive responses in
browser storage. Treat browser storage as untrusted on read (validate shape + expiry).

Do:

```ts
const TTL_MS = 5 * 60 * 1000;
const MAX_BYTES = 100_000;

function cacheSet(key: string, value: unknown) {
  const payload = JSON.stringify({ v: value, exp: Date.now() + TTL_MS });
  if (payload.length > MAX_BYTES) return; // size guard
  localStorage.setItem(key, payload);
}

function cacheGet<T>(key: string): T | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const { v, exp } = JSON.parse(raw);
    if (typeof exp !== 'number' || Date.now() > exp) {
      localStorage.removeItem(key);
      return null;
    }
    return v as T;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

// On logout:
localStorage.clear();
```

Don't:

```ts
// No expiry, no size cap, survives logout, may hold sensitive data.
localStorage.setItem('findings', JSON.stringify(bigResponse));
```

---

## Testing conventions for the dashboard

- The root `vitest.config.ts` already includes `apps/**/__tests__/**/*.test.ts` (and the
  `tests/**` variant). Place dashboard unit tests under
  `apps/dashboard/src/.../__tests__/*.test.ts` -- no extra config is needed.
- The default vitest `environment` is `node`. There is no DOM by default.
- To mock Next.js cookies in route tests, mock `next/headers`:

  ```ts
  import { vi } from 'vitest';

  const store = new Map<string, string>();
  vi.mock('next/headers', () => ({
    cookies: () => ({
      get: (k: string) => (store.has(k) ? { value: store.get(k) } : undefined),
      set: (k: string, v: string) => void store.set(k, v),
      delete: (k: string) => void store.delete(k),
    }),
  }));
  ```

- For `localStorage` / `sessionStorage`, **do not** pull in `jsdom`. Build a small
  in-memory mock and assign it to `globalThis` in `beforeEach`:

  ```ts
  import { beforeEach } from 'vitest';

  function memoryStorage(): Storage {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (k) => (map.has(k) ? map.get(k)! : null),
      key: (i) => Array.from(map.keys())[i] ?? null,
      removeItem: (k) => void map.delete(k),
      setItem: (k, v) => void map.set(k, String(v)),
    } as Storage;
  }

  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: memoryStorage(),
      configurable: true,
    });
  });
  ```

- Only add the `@vitest-environment jsdom` docblock at the top of a test file **if**
  `jsdom` is actually installed as a devDependency. As of this writing it is not, so use
  the in-memory mock approach above instead.

---

## Secret rotation

All secrets are resolved through the config modules
(`packages/backend/src/config.ts`, `apps/dashboard/src/lib/encryption-config.ts`)
and both processes fail fast at boot on a missing, default, or weak value. Rotation
therefore means: set the new value in `.env` (or your secret manager), then restart
the affected services. Generate every value with `openssl rand -hex 32` unless noted.

General principles:

- Rotate from a secret manager / `.env`, never by editing committed files. `.env.example`
  contains only `replace-me-*` placeholders, which are themselves on the weak-secret
  reject list, so a copy-paste of the template cannot boot in production.
- After rotating, restart **both** the dashboard and backend so the new value is loaded;
  they share several secrets and must agree.
- For secrets with in-flight artifacts (signed JWTs, encrypted cookies, encrypted job
  payloads), follow the per-secret overlap notes below to avoid a hard cutover that
  invalidates live sessions or wedges queued jobs.

Per-secret runbook:

- **`JWT_SECRET`** (signs dashboard-issued backend JWTs and user sessions). It is shared
  by the dashboard and backend, so both must change together. Rotating invalidates every
  in-flight token: active users are forced to re-authenticate and any queued
  server-to-server call holding an old token fails closed. Rotate during a low-traffic
  window: update the value, restart dashboard and backend together. There is no dual-key
  verification path today, so treat this as a brief, deliberate cutover rather than a
  zero-downtime rotation.

- **`INTERNAL_SHARED_SECRET`** (authenticates dashboard -> backend internal calls). Shared
  by both services. Update the value and restart both at the same time; a mismatch causes
  internal calls to be rejected (`401`), so do not stagger the restarts.

- **GitHub App RSA private key (`GITHUB_PRIVATE_KEY`)**. Generate a new private key in the
  GitHub App settings (GitHub allows multiple active keys). Deploy the new key to the
  backend, verify webhook/installation auth succeeds, then delete the old key in GitHub.
  The two-key overlap window means there is no downtime: old and new keys are both valid
  until you remove the old one.

- **Webhook secrets (`GITHUB_WEBHOOK_SECRET`, `AIKIDO_WEBHOOK_SECRET`, `SNYK_WEBHOOK_SECRET`)**.
  These verify inbound webhook signatures. Update the secret in the provider's webhook
  configuration and in `.env`, then restart the backend. Briefly, in-flight webhooks
  signed with the old secret will fail signature verification; providers retry, so deploy
  the backend change and the provider-side change as close together as possible.

- **`INTEGRATION_ENCRYPTION_KEY`** (AES-256-GCM key for integration cookies and the secret
  fields in Redis job payloads; read by both the dashboard and backend). This key is
  special: rotating it makes every existing encrypted artifact undecryptable. Cookies
  fail closed gracefully (`decryptJson` returns `null`, treated as "not connected", so
  users simply re-connect the integration). Encrypted job payloads already in Redis will
  no longer decrypt; the worker treats a decryption failure as "return the value
  unchanged" rather than throwing (`lib/secret-encryption.ts`), so a stale job degrades
  rather than crash-loops, but it will not run correctly. Therefore: drain the BullMQ
  queues (or accept that in-flight jobs must be re-enqueued) before rotating, then update
  the key and restart both processes. After rotation, integrations must be re-connected so
  fresh cookies are issued under the new key.

---

## Docker socket hardening

> **CRITICAL -- IMPLEMENTED.** The backend no longer bind-mounts the raw host
> Docker socket. It talks to a least-privilege `tecnativa/docker-socket-proxy`
> over an internal network, sandbox containers run with dropped caps + a
> read-only rootfs on a no-egress network, and (in production) under the gVisor
> `runsc` runtime. Config lives in `packages/sandbox-runner/src/sandbox-config.ts`;
> host setup in `scripts/setup-sandbox.sh`.

The validated-fix pipeline spawns sibling `sutura/sandbox-*` containers to apply patches,
run tests, and re-scan in isolation. Mounting the raw socket would grant the backend full
control of the host Docker daemon (effectively root on the host) -- a single RCE in the
backend would become host compromise. The implemented controls remove that path:

1. **Docker socket proxy (done).** `docker-compose.yml` runs `tecnativa/docker-socket-proxy`
   with the host socket mounted **read-only**, exposing only the endpoints the pipeline uses
   (`CONTAINERS`, `IMAGES`, `NETWORKS`, `EXEC`, `POST`) and denying everything else
   (`VOLUMES`, `SECRETS`, `SWARM`, `SERVICES`, `CONFIGS`, daemon config). The backend talks
   to it via `DOCKER_HOST` / `DOCKER_SOCKET_PROXY_URL=tcp://docker-socket-proxy:2375`; the
   raw `/var/run/docker.sock` mount on the backend service is removed. In production,
   `getSandboxConfig()` throws at boot if it would fall back to the raw socket with no proxy.

2. **Hardened sandbox HostConfig (done).** Each sandbox container drops all Linux
   capabilities (`CapDrop: ['ALL']`), runs with `ReadonlyRootfs` (only `/work` and `/tmp`
   are writable tmpfs, `/tmp` mounted `noexec,nosuid`), enforces a `PidsLimit` (fork-bomb
   guard) alongside the existing cpu/memory caps, keeps `no-new-privileges`, and attaches to
   an **internal no-egress network** by default (`SANDBOX_ENABLE_EGRESS=false`). Only the
   install step opts into egress (optionally via an allow-listed `HTTP(S)_PROXY`); tests and
   scans run with no route off-host.

3. **gVisor runtime (done, prod-default).** Sandbox containers run under the gVisor `runsc`
   runtime so untrusted patch code is isolated from the host kernel. `SANDBOX_RUNTIME`
   defaults to `runsc` in production (and `getSandboxConfig()` refuses to boot production on
   `runc`); compose/dev default to `runc` so local runs work without gVisor installed. Run
   `scripts/setup-sandbox.sh` on a host to install runsc, build the sandbox images, create
   the no-egress network, and start the proxy.

Remaining defense-in-depth follow-ups (not blocking):

- **Out-of-process sandbox orchestrator.** Longer term, move sandbox orchestration out of
  the request-handling backend into a dedicated, minimal-surface service that is the only
  component with proxy access, so a compromise of the web/API tier never touches Docker.

Continue to keep the backend image minimal, never expose its port publicly without auth, and
treat the validated-fix worker as a high-trust component.
