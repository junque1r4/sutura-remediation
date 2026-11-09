# Getting started with Sutura

Sutura ingests scanner findings, generates fixes with Claude, and attempts to validate
patches in disposable sandboxes before opening a pull request. This is an MVP: the
complete production flow with gVisor still requires end-to-end validation.

## 1. Get the code and configure access

Install Git and Docker with Compose. Development outside containers also requires Node.js
from a maintained LTS release, preferably Node.js 24, and npm. The declared `>=20`
engine is a compatibility floor; do not choose an end-of-life runtime for deployment.

```bash
git clone https://github.com/junque1r4/sutura-remediation.git
cd sutura-remediation
cp .env.example .env
```

In `.env`, replace the placeholders for `JWT_SECRET`, `INTEGRATION_ENCRYPTION_KEY`,
`POSTGRES_PASSWORD`, and `REDIS_PASSWORD`. Generate a different value for each by running:

```bash
openssl rand -hex 32
```

Add your initial owner account:

```dotenv
BOOTSTRAP_OWNER_EMAIL=you@example.com
BOOTSTRAP_OWNER_PASSWORD=<your-strong-password>
```

Compose builds the internal database and Redis URLs using those passwords. For host-based
execution, update `DATABASE_URL` and `REDIS_URL` too. Never commit the `.env` file.

## 2. Start the application

```bash
docker compose up -d --build
docker compose ps
curl -fsS http://localhost:3001/health
```

Open **http://localhost:3000/login** and sign in with the account you configured. The backend
applies database migrations at startup. If startup fails, inspect the logs:

```bash
docker compose logs --tail=100 backend dashboard
```

Initial account creation requires a reachable database. Changing the bootstrap password
later does not reset an existing account's password.

## 3. Prepare the remediation environment

On macOS/Docker Desktop, build the sandbox images with:

```bash
SKIP_RUNSC=1 SKIP_PROXY=1 ./scripts/setup-sandbox.sh
```

If building a language image manually, pass `--build-arg BASE_IMAGE=sutura/sandbox-base:latest`
after building the base image. See the [sandbox runner guide](../../packages/sandbox-runner/README.md).

This downloads toolchains, uses disk space, and may take several minutes. Compose provides
the Docker socket proxy. Local development uses `runc`; production requires Linux with
gVisor (`runsc`).

## 4. Connect integrations and try a fix

1. In **Settings**, connect Aikido or Snyk, Anthropic, and GitHub. Configure the GitHub App
   variables listed in the [README](../../README.md#configuration-reference).
2. Choose a test repository you control. Configure the appropriate dependency restoration,
   build, and test commands.
3. Use **Sync now** on the Findings page and open a reproducible finding.
4. Start a validated fix and follow its progress in **Fix History**. AI calls incur
   Anthropic API usage costs.
5. Review the diff, test and scan results, pull request, and CI before merging.

For periodic synchronization with persisted findings, set these in `.env`:

```dotenv
SCANNER_SYNC_ENABLED=true
NEXT_PUBLIC_FINDINGS_FROM_DB=true
```

Then run `docker compose up -d --build`: the `NEXT_PUBLIC_*` setting is included in the
dashboard bundle at build time.

## 5. Production and maintenance

- [Azure deployment](../../deploy/azure/README.md): Linux VM, gVisor, Key Vault, and manual deployment reference assets.
- [Database password rotation](database-passwords.md): procedures for existing volumes.
- [Toolchain limits](../../README.md#sandbox-support-and-limits): support by language.
- [Security guidelines](../security-guidelines.md): isolation and authorization boundaries.

For a repository without a configured test command, a successful rescan does not mean the
application was built and tested. Validate the complete flow in your environment before
treating its output as production evidence.
