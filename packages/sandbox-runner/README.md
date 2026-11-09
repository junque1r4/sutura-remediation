# @sutura/sandbox-runner

Ephemeral Docker workspace per validated-fix attempt. Spawns sibling containers
via the host's Docker socket, applies the agent's patch via `git apply`, runs
tests, then runs a local security scanner to confirm the original finding is
gone. When an Aikido API key is supplied, the rescan uses the Aikido local CLI
inside the sandbox; otherwise (or when the CLI isn't installed in the image)
it falls back to npm-audit / pip-audit / osv-scanner / semgrep.

## Building the images

The runner expects three images on the host:

```sh
# from repo root
docker build -t sutura/sandbox-base:latest -f packages/sandbox-runner/Dockerfile.base packages/sandbox-runner
docker build --build-arg BASE_IMAGE=sutura/sandbox-base:latest -t sutura/sandbox-node:latest -f packages/sandbox-runner/Dockerfile.node packages/sandbox-runner
docker build --build-arg BASE_IMAGE=sutura/sandbox-base:latest -t sutura/sandbox-python:latest -f packages/sandbox-runner/Dockerfile.python packages/sandbox-runner
```

The language images (node, python, java, dotnet) require `--build-arg BASE_IMAGE=...`:
they have no default base, so a build without it fails with a blank base name
instead of pulling `sutura/sandbox-base` from a public registry. Build the base
first and pass its local tag, as above. `scripts/setup-sandbox.sh` does all of this.

Optional images (build only if you have repos in those languages):

```sh
docker build --build-arg BASE_IMAGE=sutura/sandbox-base:latest -t sutura/sandbox-java:latest -f packages/sandbox-runner/Dockerfile.java packages/sandbox-runner
docker build --build-arg BASE_IMAGE=sutura/sandbox-base:latest -t sutura/sandbox-dotnet:latest -f packages/sandbox-runner/Dockerfile.dotnet packages/sandbox-runner
```

- `sutura/sandbox-go:latest`
- `sutura/sandbox-ruby:latest`

### Aikido CLI

The base image attempts to install the Aikido local-scan CLI (`@aikidosec/cli`
or `aikido-cli` -- whichever is published) so that `runSecurityScan` can ask
Aikido to validate the patched workspace locally. If the install fails or you
want to skip it, pass `--build-arg AIKIDO_CLI_INSTALL=skip` when building
`Dockerfile.base`. The runner gracefully falls back to OSS scanners when the
CLI is missing.

The runtime caller passes the org's Aikido API key (`client_id:client_secret`)
through `runSecurityScan(finding, ws, runner, { aikidoApiKey })`; the runner
forwards it as `AIKIDO_API_KEY` env into the CLI invocation. No key, no Aikido
local scan -- the runner falls back to OSS.

## Public surface

```ts
import { DockerSandboxRunner, runSecurityScan } from '@sutura/sandbox-runner';

const runner = new DockerSandboxRunner();
const ws = await runner.createWorkspace(repoTarball);
await runner.applyPatch(ws, unifiedDiff);
await runner.install(ws);
const tests = await runner.runTests(ws, ['__tests__/foo.sutura.test.ts']);
const scan = await runSecurityScan(finding, ws, runner, {
  aikidoApiKey: process.env.AIKIDO_API_KEY, // optional
});
await runner.cleanup(ws);
```

The worker container must mount `/var/run/docker.sock`.
