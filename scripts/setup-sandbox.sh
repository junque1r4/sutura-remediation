#!/usr/bin/env bash
#
# setup-sandbox.sh -- one-time, idempotent host setup for the hardened sandbox.
#
# Installs the gVisor runtime (runsc), builds the sandbox base + language
# images, creates the internal no-egress network, and starts the
# docker-socket-proxy. Safe to re-run: every step checks for existing state
# before acting.
#
# This script is NOT run automatically. Run it manually on a sandbox host:
#   sudo ./scripts/setup-sandbox.sh
#
# Env overrides:
#   SANDBOX_EGRESS_NETWORK  no-egress network name   (default: no-egress-net)
#   SKIP_RUNSC=1            skip gVisor install      (dev hosts without root)
#   SKIP_IMAGES=1          skip image builds
#   SKIP_PROXY=1           skip docker-socket-proxy
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX_DIR="${REPO_ROOT}/packages/sandbox-runner"
EGRESS_NETWORK="${SANDBOX_EGRESS_NETWORK:-no-egress-net}"
PROXY_IMAGE="tecnativa/docker-socket-proxy:0.3.0"
PROXY_NAME="sutura-docker-socket-proxy"

log() { printf '[setup-sandbox] %s\n' "$*"; }

require() {
  command -v "$1" >/dev/null 2>&1 || { log "ERROR: '$1' is required but not found in PATH"; exit 1; }
}

require docker

# --- 1. gVisor (runsc) -------------------------------------------------------
install_runsc() {
  if [ "${SKIP_RUNSC:-0}" = "1" ]; then
    log "SKIP_RUNSC=1; skipping gVisor install"
    return
  fi
  if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"runsc"'; then
    log "gVisor (runsc) already registered with Docker; skipping install"
    return
  fi
  if command -v runsc >/dev/null 2>&1; then
    log "runsc binary present but not registered with Docker; configuring daemon"
  else
    log "Installing gVisor (runsc)"
    # Official install per https://gvisor.dev/docs/user_guide/install/
    local arch url tmp
    arch="$(uname -m)"
    url="https://storage.googleapis.com/gvisor/releases/release/latest/${arch}"
    tmp="$(mktemp -d)"
    ( cd "$tmp" && \
      wget --quiet "${url}/runsc" "${url}/runsc.sha512" \
        "${url}/containerd-shim-runsc-v1" "${url}/containerd-shim-runsc-v1.sha512" && \
      sha512sum -c runsc.sha512 -c containerd-shim-runsc-v1.sha512 && \
      chmod a+rx runsc containerd-shim-runsc-v1 && \
      sudo mv runsc containerd-shim-runsc-v1 /usr/local/bin )
    rm -rf "$tmp"
  fi
  log "Registering runsc with the Docker daemon (runsc install)"
  sudo runsc install
  log "Restarting Docker so the runsc runtime is picked up"
  sudo systemctl restart docker || log "WARN: could not restart docker via systemctl; restart it manually"
}

# --- 2. Sandbox images -------------------------------------------------------
build_images() {
  if [ "${SKIP_IMAGES:-0}" = "1" ]; then
    log "SKIP_IMAGES=1; skipping image builds"
    return
  fi
  log "Building sutura/sandbox-base:latest"
  docker build -t sutura/sandbox-base:latest -f "${SANDBOX_DIR}/Dockerfile.base" "${SANDBOX_DIR}"
  log "Building sutura/sandbox-node:latest"
  docker build --build-arg BASE_IMAGE=sutura/sandbox-base:latest -t sutura/sandbox-node:latest -f "${SANDBOX_DIR}/Dockerfile.node" "${SANDBOX_DIR}"
  log "Building sutura/sandbox-python:latest"
  docker build --build-arg BASE_IMAGE=sutura/sandbox-base:latest -t sutura/sandbox-python:latest -f "${SANDBOX_DIR}/Dockerfile.python" "${SANDBOX_DIR}"
  log "Building sutura/sandbox-java:latest (JDK + Gradle/Maven)"
  docker build --build-arg BASE_IMAGE=sutura/sandbox-base:latest -t sutura/sandbox-java:latest -f "${SANDBOX_DIR}/Dockerfile.java" "${SANDBOX_DIR}"
  log "Building sutura/sandbox-dotnet:latest (baked .NET SDK)"
  docker build --build-arg BASE_IMAGE=sutura/sandbox-base:latest -t sutura/sandbox-dotnet:latest -f "${SANDBOX_DIR}/Dockerfile.dotnet" "${SANDBOX_DIR}"
}

# --- 3. No-egress network ----------------------------------------------------
create_network() {
  if docker network inspect "${EGRESS_NETWORK}" >/dev/null 2>&1; then
    log "Network '${EGRESS_NETWORK}' already exists; skipping"
    return
  fi
  log "Creating internal no-egress network '${EGRESS_NETWORK}'"
  # --internal: no route off-host (matches DockerSandboxRunner.ensureNoEgressNetwork).
  docker network create --driver bridge --internal \
    --label sutura.sandbox=1 "${EGRESS_NETWORK}"
}

# --- 4. docker-socket-proxy --------------------------------------------------
start_proxy() {
  if [ "${SKIP_PROXY:-0}" = "1" ]; then
    log "SKIP_PROXY=1; skipping docker-socket-proxy"
    return
  fi
  if [ -n "$(docker ps -q -f "name=^${PROXY_NAME}$" 2>/dev/null)" ]; then
    log "docker-socket-proxy '${PROXY_NAME}' already running; skipping"
    return
  fi
  # Remove a stopped container of the same name so the run below is idempotent.
  docker rm -f "${PROXY_NAME}" >/dev/null 2>&1 || true
  log "Starting docker-socket-proxy '${PROXY_NAME}'"
  docker run -d --restart unless-stopped --name "${PROXY_NAME}" \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    -e CONTAINERS=1 -e IMAGES=1 -e NETWORKS=1 -e EXEC=1 -e POST=1 \
    -e VOLUMES=0 -e SECRETS=0 -e SWARM=0 -e SERVICES=0 -e CONFIGS=0 \
    -e NODES=0 -e TASKS=0 -e PLUGINS=0 -e SYSTEM=0 -e INFO=0 -e AUTH=0 \
    -e BUILD=0 -e COMMIT=0 -e DISTRIBUTION=0 -e SESSION=0 \
    "${PROXY_IMAGE}"
}

install_runsc
build_images
create_network
start_proxy

log "Done. Sandbox host is ready."
log "Set SANDBOX_RUNTIME=runsc and DOCKER_SOCKET_PROXY_URL in the backend environment to use the hardened path."
