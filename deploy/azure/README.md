# Deploying Sutura on Azure

This directory contains reference assets for a **single Azure Linux VM**:
Bicep infrastructure, a production compose stack, a TLS reverse proxy, and a
Key-Vault-backed deploy script. Deployment and end-to-end behavior still need
operator validation. GitHub Actions workflows are not included in this public
snapshot; pushing a commit or tag does not deploy the application.

## Why a VM (and not Container Apps / AKS)

The validated-fix worker runs untrusted AI patches inside **sibling Docker
containers** and, in production, refuses to boot unless it has **gVisor
(`runsc`)** and a **Docker socket proxy**
(`packages/sandbox-runner/src/sandbox-config.ts`). That requires control of the
Docker daemon and a custom OCI runtime — which on Azure means a Linux VM. The
rest of the stack (dashboard, backend, Postgres, Redis, proxy) runs as compose
services on the same host.

## Architecture

```
Internet ──443──> Caddy (auto-TLS) ──> app.<domain>  -> dashboard:3000
                                  └──> api.<domain>  -> backend:3001
                                                          │
   backend ──tcp://docker-socket-proxy:2375──> Docker daemon (runsc)
                                                          │
   postgres:5432   redis:6379   sutura-sbx-* sandbox containers (no-egress-net)
```

Only `80`/`443` (and `22` from your admin IP) are exposed. The socket proxy,
app ports, Postgres, and Redis stay on the internal compose network.

## Files

| File                           | Purpose                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| `bicep/main.bicep` (+ modules) | ACR, Key Vault, VM, networking, role assignments                  |
| `cloud-init.yaml`              | One-time host prep: Docker, gVisor, data disk, no-egress net      |
| `docker-compose.prod.yml`      | Production stack (ACR images, hardened backend, Caddy)            |
| `Caddyfile`                    | Reverse proxy + automatic Let's Encrypt TLS                       |
| `deploy.sh`                    | On-VM deploy: render `.env` from Key Vault, pull, re-tag, `up -d` |
| `.env.production.template`     | Shape of the rendered `.env` (manual deploys / reference)         |
| `parameters.example.json`      | Example Bicep parameters                                          |

## Prerequisites

- Azure CLI logged in (`az login`) with rights to create resources + role
  assignments in the target subscription.
- A domain with two DNS records (created **after** you have the VM public IP):
  `app.<domain>` and `api.<domain>` → the VM's public IP.
- An SSH public key for VM admin access.

## 1. Provision infrastructure

```bash
az group create -n sutura-rg -l westeurope

# Edit parameters first: set adminSourceAddressPrefix to YOUR ip/cidr,
# dnsLabelPrefix to a unique label, and (optionally) deployerObjectId to your
# AAD object id (az ad signed-in-user show --query id -o tsv) so you can seed
# secrets into Key Vault.
az deployment group create \
  -g sutura-rg \
  -f deploy/azure/bicep/main.bicep \
  -p @deploy/azure/parameters.example.json \
  -p adminPublicKey="$(cat ~/.ssh/id_rsa.pub)"
```

Note the outputs (`acrLoginServer`, `acrName`, `keyVaultName`, `vmName`,
`vmPublicIp`, `vmFqdn`). cloud-init runs on first boot (~3–5 min) to install
Docker + gVisor and mount the data disk; check progress with
`sudo tail -f /var/log/sutura-host-setup.log` over SSH.

## 2. Point DNS

Create `A` records for `app.<domain>` and `api.<domain>` → `vmPublicIp`
(or `CNAME` → `vmFqdn`). TLS issuance needs these resolving first.

## 3. Seed secrets into Key Vault

Key Vault secret names use dashes in place of underscores (e.g. `JWT_SECRET` →
`jwt-secret`). Required: `jwt-secret`, `integration-encryption-key`,
`postgres-password`, `redis-password`. Add the rest as your integrations need
(`anthropic-api-key`, `pinecone-api-key`, `voyage-api-key`, GitHub App,
webhook secrets, SMTP, bootstrap owner — see `.env.production.template`).

```bash
KV=<keyVaultName>
az keyvault secret set --vault-name "$KV" --name jwt-secret               --value "$(openssl rand -hex 32)"
az keyvault secret set --vault-name "$KV" --name integration-encryption-key --value "$(openssl rand -hex 32)"
az keyvault secret set --vault-name "$KV" --name postgres-password         --value "$(openssl rand -hex 32)"
az keyvault secret set --vault-name "$KV" --name redis-password            --value "$(openssl rand -hex 32)"
# ...external keys, github-private-key (single line with \n escapes), etc.
```

> The GitHub App private key must be stored as a single line with literal `\n`
> escapes, matching how the app reads `GITHUB_PRIVATE_KEY`.

## 4. Build and publish images manually

Use an authorized Azure CLI session with the minimum registry permissions needed.
The commands below are reference instructions, not evidence that these images have
been built or deployed for your environment. Set the registry, application domain,
and an immutable release tag for your own deployment:

```bash
export ACR_NAME=<yourRegistryName>
export ACR_LOGIN_SERVER=<yourRegistryName>.azurecr.io
export API_DOMAIN=api.example.com
export IMAGE_TAG=<yourReleaseTag>
az acr login --name "$ACR_NAME"

docker build -f Dockerfile.backend \
  -t "$ACR_LOGIN_SERVER/sutura-backend:$IMAGE_TAG" .
docker push "$ACR_LOGIN_SERVER/sutura-backend:$IMAGE_TAG"

docker build -f Dockerfile.dashboard \
  --build-arg NEXT_PUBLIC_BACKEND_URL="https://$API_DOMAIN" \
  --build-arg NEXT_PUBLIC_FINDINGS_FROM_DB=false \
  -t "$ACR_LOGIN_SERVER/sutura-dashboard:$IMAGE_TAG" .
docker push "$ACR_LOGIN_SERVER/sutura-dashboard:$IMAGE_TAG"

docker build -f packages/sandbox-runner/Dockerfile.base \
  -t "$ACR_LOGIN_SERVER/sutura-sandbox-base:$IMAGE_TAG" packages/sandbox-runner
docker push "$ACR_LOGIN_SERVER/sutura-sandbox-base:$IMAGE_TAG"
for image in node python java dotnet; do
  docker build -f "packages/sandbox-runner/Dockerfile.$image" \
    --build-arg BASE_IMAGE="$ACR_LOGIN_SERVER/sutura-sandbox-base:$IMAGE_TAG" \
    -t "$ACR_LOGIN_SERVER/sutura-sandbox-$image:$IMAGE_TAG" packages/sandbox-runner
  docker push "$ACR_LOGIN_SERVER/sutura-sandbox-$image:$IMAGE_TAG"
done
```

`NEXT_PUBLIC_BACKEND_URL` and `NEXT_PUBLIC_FINDINGS_FROM_DB` are baked into the
dashboard bundle. Changing either requires a rebuild.

## 5. Deploy manually

SSH to the VM, copy `deploy/azure/{docker-compose.prod.yml,Caddyfile,deploy.sh}`
to `/opt/sutura`, then:

```bash
cd /opt/sutura
export KEYVAULT_NAME=... ACR_NAME=... ACR_LOGIN_SERVER=... IMAGE_TAG=latest \
       APP_DOMAIN=app.example.com API_DOMAIN=api.example.com ACME_EMAIL=ops@example.com
./deploy.sh
```

## 6. Configure webhooks (optional)

Point scanner/GitHub webhooks at the backend:

- GitHub App: `https://<API_DOMAIN>/webhooks/github`
- Aikido: `https://<API_DOMAIN>/webhooks/aikido`
- Snyk: `https://<API_DOMAIN>/webhooks/snyk`

No public inbound webhooks? Set `scanner-sync-enabled=true` in Key Vault to use
the outbound poll instead (`SCANNER_SYNC_ENABLED`).

## Verification

```bash
# On the VM:
docker compose -f /opt/sutura/docker-compose.prod.yml ps     # all healthy
docker info | grep -iA2 -i runtimes                           # lists 'runsc'

# From anywhere:
curl -fsS https://api.<domain>/health                         # {"status":"ok"}
curl -fsS -o /dev/null -w '%{http_code}\n' https://app.<domain>/login   # 200
```

Then log in with the bootstrap owner and trigger a validated-fix job; confirm a
`sutura-sbx-*` container is created under the `runsc` runtime
(`docker ps --filter name=sutura-sbx`).

## Operations notes

- **Postgres password is fixed at first boot.** `POSTGRES_PASSWORD` only applies
  when the `postgres-data` volume is first created. Rotating it on an existing
  volume causes auth failures — see the root `README.md` "Rotating the database
  password" before changing it.
- **Backups:** data lives in the `postgres-data` / `redis-data` Docker volumes on
  the data disk. Use Azure managed-disk snapshots of the data disk for backups.
- **Updates:** build and publish a new immutable image tag, then rerun the
  manual deploy procedure with that tag. No deployment workflow is configured.
