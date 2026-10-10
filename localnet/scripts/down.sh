#!/usr/bin/env bash
# Tear down the upload-relay and the Sui + Walrus localnet testbed. Pass --clean to also remove the
# harvested config, the .env.localnet contract, and the upstream checkout.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if [ -f "${RELAY_COMPOSE}" ]; then
  LOCAL_TESTBED_NETWORK="$(dock network ls --format '{{.Name}}' | grep -E 'local.?testbed' | head -1 || true)"
  export LOCAL_TESTBED_NETWORK
  dock compose -f "${RELAY_COMPOSE}" down -v >/dev/null 2>&1 || true
  log "relay stopped"
fi

if [ -f "${UPSTREAM_COMPOSE}" ]; then
  write_testbed_env  # ensure compose can interpolate vars even under sudo
  testbed_compose down -v >/dev/null 2>&1 || true
  log "testbed stopped"
fi

if [ "${1:-}" = "--clean" ]; then
  # The testbed Sui config (localnet/.sui) only holds keys for the chain being destroyed.
  rm -rf "${LN_GENERATED}" "${LN_ENV_FILE}" "${LN_SUI_CONFIG_DIR}" 2>/dev/null || true
  # Docker may create root-owned directories inside the upstream checkout (e.g. when a testbed.override
  # uses a relative path that resolves into .walrus-upstream/). A plain rm is tried first; the sudo
  # escalation happens only on explicit opt-in (MW_ALLOW_SUDO=1), otherwise the leftover is reported.
  if [ -d "${LN_UPSTREAM}" ]; then
    if ! rm -rf "${LN_UPSTREAM}" 2>/dev/null; then
      if [ "${MW_ALLOW_SUDO}" = "1" ]; then
        sudo rm -rf "${LN_UPSTREAM}"
      else
        warn "could not remove ${LN_UPSTREAM} (root-owned files inside). Remove it with sudo yourself, or re-run with MW_ALLOW_SUDO=1."
      fi
    fi
  fi
  log "removed generated config, .env.localnet, the testbed Sui config (.sui) and .walrus-upstream"
fi
