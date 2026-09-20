#!/usr/bin/env bash
# Bring up the Sui + Walrus localnet testbed (upstream MystenLabs/walrus docker/local-testbed).
# The upload-relay and app-facing config are added afterwards by bootstrap-localnet.sh.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require docker
require git
dock compose version >/dev/null 2>&1 || die "docker compose v2 is required"

# 1. Pin the upstream walrus checkout (shallow) that provides docker/local-testbed. We fetch + check
#    out the exact pinned ref every run (works for tags, branches, or a commit SHA on GitHub), so
#    changing WALRUS_REPO_REF re-pins an existing checkout rather than silently reusing a stale one.
if [ ! -d "${LN_UPSTREAM}/.git" ]; then
  log "initialising .walrus-upstream"
  git init -q "${LN_UPSTREAM}"
  git -C "${LN_UPSTREAM}" remote add origin "${WALRUS_REPO_URL}" 2>/dev/null || true
fi
log "checking out ${WALRUS_REPO_URL} @ ${WALRUS_REPO_REF}"
git -C "${LN_UPSTREAM}" fetch --depth 1 origin "${WALRUS_REPO_REF}" 2>/dev/null \
  || git -C "${LN_UPSTREAM}" fetch --depth 1 origin "refs/tags/${WALRUS_REPO_REF}" \
  || die "could not fetch ref '${WALRUS_REPO_REF}' from ${WALRUS_REPO_URL}"
git -C "${LN_UPSTREAM}" checkout -q --force FETCH_HEAD

[ -f "${UPSTREAM_COMPOSE}" ] || die "upstream compose not found at ${UPSTREAM_COMPOSE} — docker/local-testbed may not exist for ref ${WALRUS_REPO_REF} (pin a release tag that still ships it, e.g. testnet-v1.55.2)."

# The upstream compose still declares the obsolete top-level `version:` key, which Compose v2 warns
# about on every invocation. Strip it from our throwaway checkout (gitignored + re-checked-out each
# run, so this is transient and non-destructive).
sed -i '/^version:[[:space:]]/d' "${UPSTREAM_COMPOSE}" 2>/dev/null || true

# Write exported vars to the testbed .env so Docker Compose can interpolate them regardless of
# whether dock() uses sudo (sudo strips user-defined env vars; .env is always loaded by compose).
write_testbed_env

# 2. Prepare the runtime deployer config. testbed.override.yml mounts generated/deployer-sui-config
#    into walrus-deploy so it uses our fixed localnet key (FIXED_DEPLOYER_ADDR). We copy client.yaml
#    and generate the keystore dynamically from the hardcoded FIXED_DEPLOYER_PRIVKEY_B64.
#    generated/ is gitignored, so container writes do not propagate back to committed files.
mkdir -p "${LN_GENERATED}/deployer-sui-config"
cp "${DEPLOYER_SUI_CFG_DIR}/client.yaml" "${LN_GENERATED}/deployer-sui-config/client.yaml"

# Generate sui.keystore dynamically from the hardcoded private key. This is localnet-only and
# does not introduce security risk: the key is ephemeral, used only for local testing, and never
# touches production or long-lived services. Do NOT use this key/address for anything besides
# the localnet harness.
KEYSTORE_PATH="${LN_GENERATED}/deployer-sui-config/sui.keystore"

# Generate the keystore entry: prepend Ed25519 scheme byte (0x00) to the raw 32-byte private key,
# then base64-encode the resulting 33 bytes. The Sui keystore format is a JSON array of entries.
# We pipe the decoded private key through printf to prepend the scheme byte, then base64-encode.
KEYSTORE_ENTRY="$(echo -n "${FIXED_DEPLOYER_PRIVKEY_B64}" | base64 -d | \
  (printf '\x00'; cat) | base64 -w 0)" \
  || die "failed to generate keystore entry from private key"

# Write the keystore as a JSON array with one entry
printf '["%s"]' "${KEYSTORE_ENTRY}" > "${KEYSTORE_PATH}" \
  || die "failed to write keystore to ${KEYSTORE_PATH}"
log "deployer config ready at generated/deployer-sui-config (addr: ${FIXED_DEPLOYER_ADDR})"

# 3. Stand up the testbed (Sui validators + faucet + fullnode + 4 walrus storage nodes), with our
#    override publishing the Sui fullnode + faucet to the host.
log "walrus-service image: ${WALRUS_IMAGE_NAME}  (override with WALRUS_IMAGE_NAME=…)"
log "starting local-testbed (pulls images on first run)…"
# `walrus-deploy` is a one-shot service; if it fails, `up -d` returns non-zero. Tolerate that here so
# we can inspect + surface its log below (the whole point of this step) instead of aborting blind.
testbed_compose up -d || warn "compose reported errors — inspecting walrus-deploy…"

# 4. The storage nodes gate on walrus-deploy (service_completed_successfully). Surface its outcome.
DEPLOY_STATE="$(dock inspect -f '{{.State.Status}}:{{.State.ExitCode}}' walrus-deploy 2>/dev/null || echo unknown)"
if [ "${DEPLOY_STATE}" != "exited:0" ]; then
  warn "walrus-deploy did not succeed (state=${DEPLOY_STATE}). Full log:"
  dock logs walrus-deploy 2>&1 | sed 's/^/    /' >&2 || true
  die "the upstream walrus-deploy step failed — see the log above."
fi

# 5. Wait for the host-published Sui faucet to answer.
wait_until 180 "Sui faucet (${LN_FAUCET_URL})" \
  bash -c "curl -fsS -o /dev/null -X POST '${LN_FAUCET_URL}' -H 'Content-Type: application/json' -d '{\"FixedAmountRequest\":{\"recipient\":\"0x0000000000000000000000000000000000000000000000000000000000000000\"}}' || curl -fsS -o /dev/null '${LN_RPC_URL}'"

log "testbed up. Next: bash scripts/bootstrap-localnet.sh"
