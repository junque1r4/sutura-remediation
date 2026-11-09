#!/usr/bin/env bash
#
# deploy.sh -- on-VM deploy for Sutura (idempotent; safe to re-run).
#
# Runs ON the Azure VM. Authenticates with the VM's managed identity, renders
# /opt/sutura/.env from Key Vault, pulls the app + sandbox images from ACR,
# re-tags the sandbox images to the names the runner expects, and (re)starts the
# compose stack.
#
# Invoked by the CI deploy workflow via `az vm run-command invoke`, or run by
# hand after SSHing in. The docker-compose.prod.yml + Caddyfile must already be
# present in /opt/sutura (CI ships them; a manual deploy copies deploy/azure/*).
#
# Required environment (passed by CI / set before a manual run):
#   KEYVAULT_NAME      e.g. suturakvxxxx
#   ACR_NAME           e.g. suturaacrxxxx
#   ACR_LOGIN_SERVER   e.g. suturaacrxxxx.azurecr.io
#   IMAGE_TAG          git SHA or release tag to run
#   APP_DOMAIN         dashboard hostname (e.g. app.example.com)
#   API_DOMAIN         backend hostname   (e.g. api.example.com)
#   ACME_EMAIL         Let's Encrypt contact email
set -euo pipefail

APP_DIR="/opt/sutura"
ENV_FILE="${APP_DIR}/.env"
COMPOSE_FILE="${APP_DIR}/docker-compose.prod.yml"
SANDBOX_IMAGES=(base node python java dotnet)

log() { printf '[deploy] %s\n' "$*"; }
require_env() { for v in "$@"; do [ -n "${!v:-}" ] || { echo "ERROR: \$$v is required"; exit 1; }; done; }

require_env KEYVAULT_NAME ACR_NAME ACR_LOGIN_SERVER IMAGE_TAG APP_DOMAIN API_DOMAIN ACME_EMAIL
cd "$APP_DIR"

# --- 1. Authenticate with the VM managed identity ---------------------------
log "Logging in with managed identity"
az login --identity --only-show-errors >/dev/null

# --- 2. Render .env from Key Vault ------------------------------------------
# Key Vault secret names can't contain underscores; we store FOO_BAR as foo-bar.
# Required secrets fail the deploy if absent; optional ones are skipped silently.
REQUIRED_SECRETS=(JWT_SECRET INTEGRATION_ENCRYPTION_KEY POSTGRES_PASSWORD REDIS_PASSWORD)
OPTIONAL_SECRETS=(
  ANTHROPIC_API_KEY PINECONE_API_KEY PINECONE_ENVIRONMENT VOYAGE_API_KEY
  GITHUB_APP_ID GITHUB_PRIVATE_KEY GITHUB_WEBHOOK_SECRET GITHUB_APP_SLUG
  AIKIDO_WEBHOOK_SECRET SNYK_API_TOKEN SNYK_WEBHOOK_SECRET
  SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM
  BOOTSTRAP_OWNER_EMAIL BOOTSTRAP_OWNER_PASSWORD
  SCANNER_SYNC_ENABLED SCANNER_SYNC_INTERVAL_MS
)

kv_get() { # kv_get <ENV_NAME> -> prints value or empty
  local secret_name
  secret_name="$(echo "$1" | tr '[:upper:]_' '[:lower:]-')"
  az keyvault secret show --vault-name "$KEYVAULT_NAME" --name "$secret_name" \
    --query value -o tsv 2>/dev/null || true
}

log "Rendering ${ENV_FILE} from Key Vault '${KEYVAULT_NAME}'"
umask 077
TMP_ENV="$(mktemp)"
{
  echo "# Rendered by deploy.sh from Key Vault. Do not edit by hand."
  echo "ACR_LOGIN_SERVER=${ACR_LOGIN_SERVER}"
  echo "IMAGE_TAG=${IMAGE_TAG}"
  echo "APP_DOMAIN=${APP_DOMAIN}"
  echo "API_DOMAIN=${API_DOMAIN}"
  echo "ACME_EMAIL=${ACME_EMAIL}"
} > "$TMP_ENV"

for name in "${REQUIRED_SECRETS[@]}"; do
  val="$(kv_get "$name")"
  [ -n "$val" ] || { echo "ERROR: required secret '$name' missing in Key Vault"; rm -f "$TMP_ENV"; exit 1; }
  printf '%s=%s\n' "$name" "$val" >> "$TMP_ENV"
done
for name in "${OPTIONAL_SECRETS[@]}"; do
  val="$(kv_get "$name")"
  [ -n "$val" ] && printf '%s=%s\n' "$name" "$val" >> "$TMP_ENV"
done
mv "$TMP_ENV" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# --- 3. Authenticate Docker to ACR ------------------------------------------
log "Logging Docker in to ACR '${ACR_NAME}'"
az acr login --name "$ACR_NAME" --only-show-errors

# --- 4. Pull app images + re-tag sandbox images -----------------------------
log "Pulling app images (tag ${IMAGE_TAG})"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" pull

log "Pulling + re-tagging sandbox images to sutura/sandbox-*:latest"
for img in "${SANDBOX_IMAGES[@]}"; do
  src="${ACR_LOGIN_SERVER}/sutura-sandbox-${img}:${IMAGE_TAG}"
  dst="sutura/sandbox-${img}:latest"
  if docker pull "$src"; then
    docker tag "$src" "$dst"
  else
    log "WARN: ${src} not found; skipping (runner falls back to sandbox-base)"
  fi
done

# --- 5. Start / update the stack --------------------------------------------
log "Starting the stack"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --remove-orphans

log "Pruning dangling images"
docker image prune -f >/dev/null || true

log "Done. Stack status:"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps
