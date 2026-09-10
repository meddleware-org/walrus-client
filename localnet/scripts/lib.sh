#!/usr/bin/env bash
# Shared helpers for the Walrus localnet harness. Source this; do not execute directly.
set -euo pipefail

# ── paths ─────────────────────────────────────────────────────────────────────
LN_SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LN_ROOT="$(cd "${LN_SCRIPTS_DIR}/.." && pwd)"          # …/walrus-client/localnet
LN_UPSTREAM="${LN_ROOT}/.walrus-upstream"               # cloned MystenLabs/walrus checkout
LN_GENERATED="${LN_ROOT}/generated"                     # harvested configs (gitignored)
LN_ENV_FILE="${LN_ROOT}/.env.localnet"                  # the contract every suite consumes

# ── tunables (override via env) ───────────────────────────────────────────────
# Upstream Walrus repo + ref providing docker/local-testbed. Pin to a RECENT tag that still ships
# docker/local-testbed and is internally self-consistent (its image, deploy script, bundled contracts
# and Sui node all match) — so no downgrade or script patching is needed. `main` has dropped
# local-testbed, so we track the latest release tag that keeps it. Override via WALRUS_REPO_REF.
WALRUS_REPO_URL="${WALRUS_REPO_URL:-https://github.com/MystenLabs/walrus.git}"
WALRUS_REPO_REF="${WALRUS_REPO_REF:-testnet-v1.56.0}"

# The upstream compose hardcodes a stale image digest; override to the release-tag image so the
# binary matches the pinned ref. NOTE: Docker image tags are mutable — even a pinned release tag
# can be re-pushed with a different binary. Our patched deploy script (MW_PATCH_DEPLOY=1) is the
# stable layer: it selects flags that match the current binary API. Override WALRUS_IMAGE_NAME
# if this specific tag 404s or you need to test with a different image.
export WALRUS_IMAGE_NAME="${WALRUS_IMAGE_NAME:-mysten/walrus-service:${WALRUS_REPO_REF}}"
# The upstream compose that stands up Sui (validators + faucet + fullnode) + 4 walrus nodes.
UPSTREAM_COMPOSE="${LN_UPSTREAM}/docker/local-testbed/docker-compose.yaml"
# Our override — publishes the Sui fullnode + faucet ports to the host (upstream exposes none).
# Always applied.
TESTBED_OVERRIDE="${LN_ROOT}/testbed.override.yml"
# Override that remounts our patched deploy script + version-matched contracts. Enabled by default
# (MW_PATCH_DEPLOY=1). The `testnet-v1.56.0` image tag uses `--contract-dir` (matching the
# upstream deploy script), so our patched script auto-detects and uses the same flag. Set
# MW_PATCH_DEPLOY=0 only if you are testing with a verified internally-consistent image+script pair.
MW_PATCH_DEPLOY="${MW_PATCH_DEPLOY:-1}"
DEPLOY_PATCH_OVERRIDE="${LN_ROOT}/deploy-patch.override.yml"
# Our upload-relay compose (layers on top of the testbed network).
RELAY_COMPOSE="${LN_ROOT}/relay.compose.yml"
# Patched deploy script mounted over the upstream one by the deploy patch override (absolute path —
# compose resolves relative bind paths against the upstream compose dir, so this must be absolute).
export MW_DEPLOY_SCRIPT="${LN_ROOT}/files/deploy-walrus.sh"
# The pinned walrus checkout ships the version-matched Move contracts at contracts/. We mount them so
# the deploy builds contracts that match the (same-tag) image's compiler — deterministic, no reliance
# on the image bundling contracts or on walrus-docs latest being compiler-compatible.
export MW_CONTRACTS_DIR="${LN_UPSTREAM}/contracts"
# The walrus-deploy writes object ids into a Docker VOLUME (not a host path): the file
# `/opt/walrus/outputs/deploy` holds space-separated `system_object 0x…` lines (see the upstream
# files/run-walrus.sh, which harvests them the same way). We read it via a throwaway container.
DEPLOY_OUTPUTS_MOUNT="/opt/walrus/outputs"

# Run the testbed compose. Always applies our port-publishing override and the deploy-patch (which
# mounts the pinned contracts + patched deploy script). MW_PATCH_DEPLOY defaults to 1; set to 0
# only for testing a known-good upstream image+script pair.
testbed_compose() {
  local files=(-f "${UPSTREAM_COMPOSE}" -f "${TESTBED_OVERRIDE}")
  [ "${MW_PATCH_DEPLOY}" = "1" ] && files+=(-f "${DEPLOY_PATCH_OVERRIDE}")
  dock compose "${files[@]}" "$@"
}

# Discover the project-namespaced deploy-outputs volume (e.g. local-testbed_walrus-deploy-outputs).
# `|| true` so a no-match doesn't abort a `set -e` caller via pipefail (the caller checks emptiness).
deploy_outputs_volume() { dock volume ls --format '{{.Name}}' | { grep -E 'walrus-deploy-outputs' || true; } | head -1; }

LN_RPC_URL="${LN_RPC_URL:-http://127.0.0.1:9000}"
LN_FAUCET_URL="${LN_FAUCET_URL:-http://127.0.0.1:9123/gas}"
LN_RELAY_HOST="${LN_RELAY_HOST:-http://127.0.0.1:57391}"
LN_AGGREGATOR_HOST="${LN_AGGREGATOR_HOST:-http://127.0.0.1:57392}"

# Fixed localnet deployer keypair (pre-committed; localnet-only, not production).
# walrus-deploy is mounted this config via testbed.override.yml so the deployer address is always
# known. bootstrap-localnet.sh imports this key and transfers WAL to the test address (localnet has
# no SUI→WAL exchange, so the deployer wallet is the only WAL source).
FIXED_DEPLOYER_ADDR="0x222456ac3f6afb4bb9a10f6eae82fc8d3ac2ae3ea4c27b1516914b1708ba838c"
# Raw Ed25519 private key in base64 (32 bytes — no scheme byte prefix). This is the format
# accepted by `sui keytool import <key> ed25519`. The corresponding keystore entry (with the
# 0x00 Ed25519 scheme byte prepended) lives in config/deployer-sui-config/sui.keystore.
FIXED_DEPLOYER_PRIVKEY_B64="/zxu5t+Ezf/vyxzLWalUNt7Itw8gfiMNbQpFMYXXOVU="
# The deployer config (client.yaml + sui.keystore) is mounted into walrus-deploy at runtime.
DEPLOYER_SUI_CFG_DIR="${LN_ROOT}/config/deployer-sui-config"
# Absolute path to the RUNTIME copy of the deployer config (in generated/, which is gitignored).
# up.sh copies DEPLOYER_SUI_CFG_DIR here before starting the testbed. Exported so testbed.override.yml
# can reference it — compose resolves relative paths in override files against the FIRST compose
# file's directory (the upstream checkout), not the override's directory, so we must use absolute paths.
export MW_DEPLOYER_RUNTIME_CFG="${LN_GENERATED}/deployer-sui-config"

log()  { printf '\033[1;36m[localnet]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[localnet]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[localnet]\033[0m %s\n' "$*" >&2; exit 1; }

require() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

# Docker invocation. Prefer direct access; fall back to `sudo -E docker` when the current user can't
# reach the daemon (no docker group — some hosts don't even have one). Detected once. This lets the
# harness run as YOUR user (so `sui` uses your keystore) while docker still works via sudo per-call.
# -E preserves the calling environment so Docker Compose can interpolate exported vars like
# MW_DEPLOYER_RUNTIME_CFG, MW_DEPLOY_SCRIPT, MW_CONTRACTS_DIR. We also write those vars to the
# testbed .env file (see write_testbed_env) as a belt-and-suspenders measure, since some sudoers
# configs honour env_reset and may drop even -E-preserved variables.
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  MW_DOCKER=(docker)
else
  MW_DOCKER=(sudo -E docker)
fi
dock() { "${MW_DOCKER[@]}" "$@"; }

# Write compose variable overrides to the testbed .env file so Docker Compose can interpolate them
# even when dock() invokes sudo (which strips user-defined env vars by default on many systems).
# Must be called after the upstream checkout exists (i.e. after git checkout in up.sh).
write_testbed_env() {
  local testbed_dir="${LN_UPSTREAM}/docker/local-testbed"
  [ -d "${testbed_dir}" ] || return 0
  printf 'WALRUS_IMAGE_NAME=%s\nMW_DEPLOYER_RUNTIME_CFG=%s\nMW_DEPLOY_SCRIPT=%s\nMW_CONTRACTS_DIR=%s\n' \
    "${WALRUS_IMAGE_NAME}" "${MW_DEPLOYER_RUNTIME_CFG}" "${MW_DEPLOY_SCRIPT}" "${MW_CONTRACTS_DIR}" \
    > "${testbed_dir}/.env"
}

# Poll a shell condition until it succeeds or a timeout elapses.
#   wait_until <timeout_secs> <label> <cmd...>
wait_until() {
  local timeout="$1" label="$2"; shift 2
  local start; start="$(date +%s)"
  until "$@" >/dev/null 2>&1; do
    if (( $(date +%s) - start >= timeout )); then die "timed out waiting for: ${label}"; fi
    sleep 2
  done
  log "ready: ${label}"
}

# Extract a scalar from a YAML file without a yaml dependency (simple `key: value` lines).
yaml_scalar() { # yaml_scalar <file> <key>
  sed -n "s/^[[:space:]]*$2:[[:space:]]*\"\{0,1\}\([^\"]*\)\"\{0,1\}[[:space:]]*$/\1/p" "$1" | head -1
}
