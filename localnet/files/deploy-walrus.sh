#!/bin/bash
# Meddleware-patched copy of the upstream local-testbed deploy script.
#
# Applied by default (MW_PATCH_DEPLOY=1). Fixes version skew between the upstream scripts and the
# walrus-service image (whose Docker tag is mutable and can drift even when pinned to a release tag):
#
#   1. Flag: detects at runtime whether the binary uses `--contract-path` or `--contract-dir`
#      (+ optional `--do-not-copy-contracts`). The tag `testnet-v1.55.2` has been re-pushed multiple
#      times with binaries that flip between these two APIs. Hardcoding either flag breaks on the next
#      re-push; dynamic detection via `--help` is stable regardless of which binary is cached.
#   2. Contract source: mounts the pinned-checkout contracts (via MW_CONTRACTS_DIR) rather than
#      `git clone`-ing walrus-docs at deploy time. walrus-docs HEAD contracts may be too new for the
#      image's Move compiler → ICE. Pinned checkout contracts are guaranteed to match.
#
# The outputs (key: value lines in /opt/walrus/outputs/deploy) are identical to the upstream format.
set -euo pipefail

EPOCH_DURATION=${EPOCH_DURATION:-2m}

# Locate the `walrus` system-contract package (a dir with Move.toml). Order of preference:
#   1. The pinned checkout's contracts, mounted at /opt/walrus/mw-contracts — guaranteed to match the
#      overridden WALRUS_IMAGE_NAME (same tag), so the image's Move compiler builds them cleanly. We
#      copy to a writable dir first (the build may write Move.lock).
#   2. Contracts bundled in the image at /opt/walrus/contracts (upstream's intended source).
#   3. Last resort: clone walrus-docs (its contracts may be newer than an older image's compiler → ICE).
CONTRACT_PKG=""
if [ -f /opt/walrus/mw-contracts/walrus/Move.toml ]; then
  rm -rf /opt/walrus/mw-build
  cp -r /opt/walrus/mw-contracts /opt/walrus/mw-build
  CONTRACT_PKG=/opt/walrus/mw-build/walrus
fi
if [ -z "${CONTRACT_PKG}" ]; then
  for cand in /opt/walrus/contracts/walrus /opt/walrus/testnet-contracts/walrus; do
    if [ -f "${cand}/Move.toml" ]; then CONTRACT_PKG="${cand}"; break; fi
  done
fi
if [ -z "${CONTRACT_PKG}" ]; then
  echo "[deploy] no mounted/bundled contracts found; cloning walrus-docs as a last resort" >&2
  rm -rf walrus-docs
  git clone --depth 1 https://github.com/MystenLabs/walrus-docs.git
  rm -rf /opt/walrus/testnet-contracts
  cp -r walrus-docs/contracts /opt/walrus/testnet-contracts
  [ -f /opt/walrus/testnet-contracts/walrus/Move.toml ] && CONTRACT_PKG=/opt/walrus/testnet-contracts/walrus
fi
if [ -z "${CONTRACT_PKG}" ]; then
  echo "ERROR: could not locate the 'walrus' contract package with a Move.toml." >&2
  ls -la /opt/walrus /opt/walrus/contracts /opt/walrus/mw-contracts 2>&1 | sed 's/^/  /' >&2 || true
  exit 3
fi
echo "[deploy] building system contract from ${CONTRACT_PKG}" >&2

# Detect which contract-path flag the binary supports. The testnet-v1.55.2 tag has been re-pushed
# multiple times with binaries that switch between --contract-path and --contract-dir. Parse --help
# output once and build the appropriate argument array.
DEPLOY_BIN=/opt/walrus/bin/walrus-deploy
DEPLOY_HELP=$("${DEPLOY_BIN}" deploy-system-contract --help 2>&1 || true)
if echo "${DEPLOY_HELP}" | grep -q -- '--contract-path'; then
  # Newer binary: takes the path to the specific walrus package directory (contains Move.toml).
  CONTRACT_ARGS=(--contract-path "${CONTRACT_PKG}")
  echo "[deploy] binary API: --contract-path ${CONTRACT_PKG}" >&2
elif echo "${DEPLOY_HELP}" | grep -q -- '--contract-dir'; then
  # Older binary: takes the PARENT directory containing all sub-packages (wal/, walrus/, etc.).
  # CONTRACT_PKG points at the walrus/ sub-package; its parent is the contracts root we need.
  CONTRACT_DIR="$(dirname "${CONTRACT_PKG}")"
  CONTRACT_ARGS=(--contract-dir "${CONTRACT_DIR}")
  if echo "${DEPLOY_HELP}" | grep -q -- '--do-not-copy-contracts'; then
    CONTRACT_ARGS+=(--do-not-copy-contracts)
    echo "[deploy] binary API: --contract-dir ${CONTRACT_DIR} + --do-not-copy-contracts" >&2
  else
    echo "[deploy] binary API: --contract-dir ${CONTRACT_DIR}" >&2
  fi
else
  echo "ERROR: walrus-deploy supports neither --contract-path nor --contract-dir" >&2
  echo "${DEPLOY_HELP}" | head -40 | sed 's/^/  /' >&2
  exit 4
fi

cd /opt/walrus
rm -rf /opt/walrus/outputs/*

"${DEPLOY_BIN}" deploy-system-contract \
  --working-dir /opt/walrus/outputs \
  "${CONTRACT_ARGS[@]}" \
  --sui-network 'http://sui-localnet:9000;http://sui-localnet:9123/gas' \
  --n-shards 100 \
  --host-addresses 10.0.0.10 10.0.0.11 10.0.0.12 10.0.0.13 \
  --storage-price 5 \
  --write-price 1 \
  --epoch-duration "$EPOCH_DURATION" >/opt/walrus/outputs/deploy

/opt/walrus/bin/walrus-deploy generate-dry-run-configs \
  --working-dir /opt/walrus/outputs
