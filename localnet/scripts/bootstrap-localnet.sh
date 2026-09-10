#!/usr/bin/env bash
# Harvest the testbed's Walrus network ids, generate an app-facing client config with a `localnet`
# context, fund a test keypair, deploy the access_gate Move package to localnet, bring up the
# upload-relay, and write `.env.localnet` — the single contract every integration suite consumes.
#
# Prerequisite: `bash scripts/up.sh` completed (testbed healthy).
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

# bootstrap needs BOTH docker AND your sui keystore. Run it as YOUR normal user (NOT via sudo) so
# `sui` uses your keystore — docker access is handled automatically per-call (`dock` uses `sudo docker`
# when you're not in a docker group). Running the whole script under sudo would make sui use root's
# empty config and fail the access_gate deploy, so we refuse that.
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
  die "run this WITHOUT sudo — it needs your sui keystore, not root's:  bash scripts/bootstrap-localnet.sh
  (docker calls elevate themselves via sudo automatically; you'll be prompted for your password once.)"
fi

require docker
require sui
require curl

# The access_gate deploy (step 4) publishes to localnet, so point the sui client there regardless of
# whatever env was previously active (e.g. testnet).
log "switching sui client to the localnet env"
if ! sui client switch --env localnet >/dev/null 2>&1; then
  log "no 'localnet' env found — creating it"
  sui client new-env --alias localnet --rpc http://127.0.0.1:9000 >/dev/null 2>&1 \
    || die "failed to create localnet sui env (is the localnet RPC at http://127.0.0.1:9000 reachable?)"
  sui client switch --env localnet >/dev/null 2>&1 \
    || die "localnet env was created but switch still failed — check sui client config"
fi

# Earlier sudo runs may have left generated/ or .env.localnet owned by root; this (non-sudo) run then
# can't overwrite them. Remove any such root-owned leftovers via sudo (same elevation `dock` uses).
for p in "${LN_GENERATED}" "${LN_ENV_FILE}"; do
  if [ -e "$p" ] && [ ! -w "$p" ]; then
    warn "removing root-owned $(basename "$p") left by a previous sudo run"
    sudo rm -rf "$p"
  fi
done
mkdir -p "${LN_GENERATED}"

# 1. Harvest Walrus network object ids from the deploy-outputs Docker volume. The walrus-deploy job
#    writes `/opt/walrus/outputs/deploy` with space-separated `system_object 0x…` lines (identical to
#    how the upstream files/run-walrus.sh extracts them). Read it via a throwaway container.
#    NOTE: every grep-in-a-command-substitution below ends `|| true` — under `set -euo pipefail` a
#    grep that matches nothing (e.g. localnet has no `exchange_object`) would otherwise abort the whole
#    script silently, before any log/die runs.
log "harvesting Walrus network object ids from the testbed…"
VOL="$(deploy_outputs_volume)"
[ -n "${VOL}" ] || die "deploy-outputs volume not found — did scripts/up.sh complete (walrus-deploy healthy)?"
DEPLOY_TXT="$(dock run --rm -v "${VOL}:${DEPLOY_OUTPUTS_MOUNT}:ro" busybox cat "${DEPLOY_OUTPUTS_MOUNT}/deploy" 2>/dev/null || true)"
[ -n "${DEPLOY_TXT}" ] || die "could not read ${DEPLOY_OUTPUTS_MOUNT}/deploy from volume ${VOL}"

# The deploy prints `key: value` lines (e.g. `system_object: 0x…`), interleaved with build logs — so
# match the key followed by a colon and take field 2 (the id), mirroring upstream's run-walrus.sh.
harvest() { printf '%s\n' "${DEPLOY_TXT}" | { grep -E "^[[:space:]]*$1:" || true; } | awk '{print $2}' | head -1; }
SYSTEM_OBJECT="$(harvest system_object)"
STAKING_OBJECT="$(harvest staking_object)"
# Keep only real 0x ids — localnet has no WAL exchange, so the deploy prints `exchange_object: None`,
# which must NOT end up in the config (Walrus rejects it as an invalid ObjectID).
EXCHANGE_OBJECTS="$(printf '%s\n' "${DEPLOY_TXT}" | { grep -E '^[[:space:]]*exchange_object' || true; } | awk '{print $2}' | { grep -E '^0x[0-9a-fA-F]+$' || true; })"
[ -n "${SYSTEM_OBJECT}" ] && [ -n "${STAKING_OBJECT}" ] || die "could not harvest system_object/staking_object from the deploy output. First lines of deploy:
$(printf '%s\n' "${DEPLOY_TXT}" | head -20)"

log "harvested system_object=${SYSTEM_OBJECT} staking_object=${STAKING_OBJECT}"

# 2. Write the app-facing client config with a single `localnet` context. The RELAY runs on the
#    testbed network, so its rpc_urls use the INTERNAL Sui hostname; host-run TS tests use the
#    published 127.0.0.1 endpoint via WALRUS_RPC_URL in .env.localnet below.
RELAY_RPC_URL="${RELAY_RPC_URL:-http://sui-localnet:9000}"
{
  echo "contexts:"
  echo "  localnet:"
  echo "    system_object: ${SYSTEM_OBJECT}"
  echo "    staking_object: ${STAKING_OBJECT}"
  if [ -n "${EXCHANGE_OBJECTS}" ]; then
    echo "    exchange_objects:"
    while IFS= read -r id; do [ -n "$id" ] && echo "      - ${id}"; done <<< "${EXCHANGE_OBJECTS}"
  fi
  echo "    rpc_urls:"
  echo "      - ${RELAY_RPC_URL}"
  echo "default_context: localnet"
} > "${LN_GENERATED}/client_config.yaml"
log "wrote ${LN_GENERATED}/client_config.yaml"

# 3. Fund a test Ed25519 keypair from the faucet and export its bech32 secret for the TS suites.
#    (The sui calls are wrapped `|| true` so a non-zero exit surfaces as a clear die, not a silent
#    `set -e` abort inside the command substitution.)
log "creating + funding a localnet test keypair…"
TEST_ADDR="$({ sui client new-address ed25519 --json 2>/dev/null || true; } | sed -n 's/.*"address":[[:space:]]*"\(0x[0-9a-f]*\)".*/\1/p' | head -1)"
[ -n "${TEST_ADDR}" ] || die "failed to create a localnet test address (is 'sui client' pointed at localnet?)"
curl -fsS -X POST "${LN_FAUCET_URL}" -H 'Content-Type: application/json' \
  -d "{\"FixedAmountRequest\":{\"recipient\":\"${TEST_ADDR}\"}}" >/dev/null
TEST_SECRET="$({ sui keytool export --key-identity "${TEST_ADDR}" --json 2>/dev/null || true; } | sed -n 's/.*"exportedPrivateKey":[[:space:]]*"\(suiprivkey[0-9a-z]*\)".*/\1/p' | head -1)"
[ -n "${TEST_SECRET}" ] || die "failed to export the test keypair secret"
# Switch to the test address so subsequent sui calls (access_gate publish, etc.) use a funded address.
sui client switch --address "${TEST_ADDR}" >/dev/null 2>&1 || true
log "funded test address ${TEST_ADDR}"

# 3b. Transfer WAL from the walrus-deploy admin wallet to the test address.
# On localnet there is no SUI→WAL exchange (exchange_object: None). walrus-deploy always generates
# its own Sui keypair (ignoring any mounted Sui config) and stores it in the deploy-outputs volume at
# /opt/walrus/outputs/sui_admin.yaml. WAL is minted to that generated address during deploy.
# Strategy: read sui_admin.yaml from the volume, extract the admin address + keystore, import the
# admin private key, find the WAL coin, transfer it to TEST_ADDR, then switch back.
log "sourcing WAL: reading deploy admin wallet from outputs volume (${VOL})…"
WAL_TRANSFER_OK=0
ADMIN_YAML="$(dock run --rm -v "${VOL}:${DEPLOY_OUTPUTS_MOUNT}:ro" busybox cat "${DEPLOY_OUTPUTS_MOUNT}/sui_admin.yaml" 2>/dev/null || true)"
# Parse active_address from the standard Sui client.yaml format (with or without quotes).
ADMIN_ADDR="$(printf '%s\n' "${ADMIN_YAML}" | sed -n 's/^active_address:[[:space:]]*["'"'"']\{0,1\}\(0x[0-9a-f]*\).*/\1/p' | head -1)"
# Parse keystore File: path; take just the filename since the path is absolute inside the container.
ADMIN_KEYSTORE_PATH="$(printf '%s\n' "${ADMIN_YAML}" | sed -n 's/.*File:[[:space:]]*//p' | head -1 | sed 's/[[:space:]]*$//')"
ADMIN_KEYSTORE_FILE="${ADMIN_KEYSTORE_PATH##*/}"  # basename via parameter expansion (no subshell)

if [ -n "${ADMIN_ADDR}" ] && [ -n "${ADMIN_KEYSTORE_FILE}" ]; then
  log "deploy admin: addr=${ADMIN_ADDR}, keystore=${ADMIN_KEYSTORE_FILE}"
  ADMIN_KEYSTORE_RAW="$(dock run --rm -v "${VOL}:${DEPLOY_OUTPUTS_MOUNT}:ro" busybox cat "${DEPLOY_OUTPUTS_MOUNT}/${ADMIN_KEYSTORE_FILE}" 2>/dev/null || true)"
  # Extract the raw keystore entry (base64([scheme_byte || private_key])) from the admin keystore.
  # Rather than using `sui keytool import` (which can fail on alias conflicts and has version-varying
  # output formats), we directly append the entry to the local sui.keystore JSON array. The Sui CLI
  # reads the keystore file fresh on each invocation, so the address becomes immediately available.
  ADMIN_KEY_ENTRY="$(printf '%s' "${ADMIN_KEYSTORE_RAW}" | python3 -c "
import sys, json
try:
  keys = json.load(sys.stdin)
  if keys: print(keys[0])
except Exception as e:
  sys.stderr.write(str(e) + '\n')
" 2>/dev/null || true)"

  if [ -n "${ADMIN_KEY_ENTRY}" ]; then
    LOCAL_KEYSTORE="${HOME}/.sui/sui_config/sui.keystore"
    if [ -f "${LOCAL_KEYSTORE}" ]; then
      python3 - "${ADMIN_KEY_ENTRY}" "${LOCAL_KEYSTORE}" <<'PYEOF' 2>/dev/null || true
import sys, json
entry, ks_file = sys.argv[1], sys.argv[2]
with open(ks_file) as f:
    ks = json.load(f)
if entry not in ks:
    ks.append(entry)
    import tempfile, os
    tmp = ks_file + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(ks, f)
    os.replace(tmp, ks_file)
PYEOF
      log "admin key injected into local keystore (addr: ${ADMIN_ADDR})"
    else
      warn "local sui.keystore not found at ${LOCAL_KEYSTORE}"
    fi
  fi

  if [ -n "${ADMIN_KEY_ENTRY}" ]; then
    # walrus-deploy spends its SUI gas during contract publishing, leaving the admin wallet with
    # insufficient gas for a transfer-object call. Top it up from the localnet faucet first.
    curl -fsS -X POST "${LN_FAUCET_URL}" -H 'Content-Type: application/json' \
      -d "{\"FixedAmountRequest\":{\"recipient\":\"${ADMIN_ADDR}\"}}" >/dev/null 2>&1 || true
    # Use suix_getAllBalances (returns one entry per coin type, no pagination) to find the WAL coin
    # type string. suix_getAllCoins paginates and WAL can be beyond page 1 if the admin has many SUI
    # gas objects from the faucet. Once we have the type, suix_getCoins fetches the object id.
    ALL_BALANCES="$(curl -fsS "${LN_RPC_URL}" -X POST -H 'Content-Type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"suix_getAllBalances\",\"params\":[\"${ADMIN_ADDR}\"]}" 2>/dev/null || true)"
    WAL_COIN_TYPE="$(printf '%s' "${ALL_BALANCES}" | python3 -c "
import sys, json
try:
  for b in json.load(sys.stdin).get('result', []):
    ct = b.get('coinType', '')
    if '::wal::WAL' in ct:
      print(ct); break
except Exception: pass
" 2>/dev/null || true)"
    WAL_COIN_OBJ=""
    if [ -n "${WAL_COIN_TYPE}" ]; then
      WAL_COIN_INFO="$(curl -fsS "${LN_RPC_URL}" -X POST -H 'Content-Type: application/json' \
        -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"suix_getCoins\",\"params\":[\"${ADMIN_ADDR}\",\"${WAL_COIN_TYPE}\",null,1]}" 2>/dev/null || true)"
      WAL_COIN_OBJ="$(printf '%s' "${WAL_COIN_INFO}" | python3 -c "
import sys, json
try:
  coins = json.load(sys.stdin).get('result', {}).get('data', [])
  if coins: print(coins[0].get('coinObjectId', ''))
except Exception: pass
" 2>/dev/null || true)"
    fi
    if [ -n "${WAL_COIN_OBJ}" ]; then
      WAL_SOURCE_ADDR="${ADMIN_ADDR}"
    else
      # Admin has no WAL — probably transferred to a previous test address in an earlier bootstrap
      # run on this same testbed. Search all local keystore addresses as a fallback (handles the
      # "bootstrap ran multiple times without down --clean" scenario).
      log "WAL not at admin — scanning keystore addresses for WAL…"
      WAL_SOURCE_ADDR=""
      WAL_COIN_OBJ=""
      while IFS= read -r candidate; do
        [ -z "${candidate}" ] && continue
        [ "${candidate}" = "${ADMIN_ADDR}" ] && continue
        [ "${candidate}" = "${TEST_ADDR}" ] && continue
        cand_balances="$(curl -fsS "${LN_RPC_URL}" -X POST -H 'Content-Type: application/json' \
          -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"suix_getAllBalances\",\"params\":[\"${candidate}\"]}" 2>/dev/null || true)"
        cand_wal_type="$(printf '%s' "${cand_balances}" | python3 -c "
import sys, json
try:
  for b in json.load(sys.stdin).get('result', []):
    ct = b.get('coinType','')
    if '::wal::WAL' in ct: print(ct); break
except Exception: pass
" 2>/dev/null || true)"
        candidate_wal_obj=""
        if [ -n "${cand_wal_type}" ]; then
          cand_coins="$(curl -fsS "${LN_RPC_URL}" -X POST -H 'Content-Type: application/json' \
            -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"suix_getCoins\",\"params\":[\"${candidate}\",\"${cand_wal_type}\",null,1]}" 2>/dev/null || true)"
          candidate_wal_obj="$(printf '%s' "${cand_coins}" | python3 -c "
import sys, json
try:
  coins = json.load(sys.stdin).get('result', {}).get('data', [])
  if coins: print(coins[0].get('coinObjectId', ''))
except Exception: pass
" 2>/dev/null || true)"
        fi
        if [ -n "${candidate_wal_obj}" ]; then
          WAL_SOURCE_ADDR="${candidate}"
          WAL_COIN_OBJ="${candidate_wal_obj}"
          log "found WAL at keystore address ${candidate} (coin ${candidate_wal_obj})"
          # Fund this address for gas in case it also ran dry.
          curl -fsS -X POST "${LN_FAUCET_URL}" -H 'Content-Type: application/json' \
            -d "{\"FixedAmountRequest\":{\"recipient\":\"${candidate}\"}}" >/dev/null 2>&1 || true
          break
        fi
      done < <(sui client addresses --json 2>/dev/null | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  addrs = d if isinstance(d, list) else d.get('addresses', d.get('data', []))
  for a in addrs:
    addr = a.get('address','') if isinstance(a, dict) else (a[0] if isinstance(a, list) else a)
    if addr: print(addr)
except Exception: pass
" 2>/dev/null || true)
    fi

    if [ -n "${WAL_COIN_OBJ}" ] && [ -n "${WAL_SOURCE_ADDR}" ]; then
      sui client switch --address "${WAL_SOURCE_ADDR}" >/dev/null 2>&1 || true
      ACTIVE_ADDR="$(sui client active-address 2>/dev/null || true)"
      if [ "${ACTIVE_ADDR}" != "${WAL_SOURCE_ADDR}" ]; then
        warn "address switch failed (wanted ${WAL_SOURCE_ADDR}, got ${ACTIVE_ADDR:-unknown}) — cannot sign transfer"
      else
        # `sui client transfer-object` was removed in newer Sui CLI versions.
        # Use a PTB (Programmable Transaction Block) to transfer arbitrary objects in v1.76.1+.
        TRANSFER_OUT="$(sui client ptb \
          --transfer-objects "[@${WAL_COIN_OBJ}]" "@${TEST_ADDR}" \
          --gas-budget 50000000 2>&1)" && {
          log "WAL coin ${WAL_COIN_OBJ} transferred from ${WAL_SOURCE_ADDR} to ${TEST_ADDR}"
          WAL_TRANSFER_OK=1
        } || {
          warn "WAL transfer failed:"
          printf '%s\n' "${TRANSFER_OUT}" | grep -iE 'error|failed|cannot|insufficient' | head -5 | sed 's/^/  /' >&2 || \
            printf '%s\n' "${TRANSFER_OUT}" | head -5 | sed 's/^/  /' >&2
        }
      fi
    else
      warn "no WAL coin found anywhere in keystore — write-side integration tests will fail"
    fi
  else
    warn "could not extract admin keystore entry — WAL transfer skipped"
  fi
else
  warn "could not parse deploy admin wallet from sui_admin.yaml (addr='${ADMIN_ADDR}', keystore='${ADMIN_KEYSTORE_FILE}')"
  warn "raw sui_admin.yaml (first 15 lines — check keystore File: format):"
  printf '%s\n' "${ADMIN_YAML}" | head -15 | sed 's/^/  /' >&2
fi
# Always switch back to the funded test address for subsequent steps (access_gate publish, etc.).
sui client switch --address "${TEST_ADDR}" >/dev/null 2>&1 || true

# 4. Deploy access_gate to localnet and bootstrap a gate (reuses the package's own publish script).
AG_DIR="${LN_ROOT}/../../access-gate-sui"
[ -f "${AG_DIR}/scripts/publish.sh" ] || die "access-gate-sui not checked out at ${AG_DIR}"
log "publishing access_gate to localnet + creating a gate…"
( cd "${AG_DIR}" && ./scripts/publish.sh localnet --create-gate )
# publish.sh writes .env.localnet in the access-gate-sui dir; harvest the ids it recorded.
AG_ENV="${AG_DIR}/.env.localnet"
[ -f "${AG_ENV}" ] || die "expected ${AG_ENV} from access_gate publish"
# access-gate-sui/.env.localnet uses ACCESS_GATE_PACKAGE_ID and ACCESS_GATE_GATE_ID (note the double
# GATE) — match those exact names.
AG_PACKAGE_ID="$({ grep -oE 'ACCESS_GATE_PACKAGE_ID=0x[0-9a-f]+' "${AG_ENV}" || true; } | cut -d= -f2 | head -1)"
AG_GATE_ID="$({ grep -oE 'ACCESS_GATE_GATE_ID=0x[0-9a-f]+' "${AG_ENV}" || true; } | cut -d= -f2 | head -1)"

# 5. Bring up our gateways (upload-relay for writes + aggregator for reads), joined to the testbed
#    network. Best-effort and MUST NOT abort the run — .env.localnet (below) is the deliverable, and
#    blob WRITES need WAL on localnet regardless (see README). So health checks only warn.
LOCAL_TESTBED_NETWORK="$(dock network ls --format '{{.Name}}' | grep -E 'local.?testbed' | head -1 || true)"
export LOCAL_TESTBED_NETWORK
[ -n "${LOCAL_TESTBED_NETWORK}" ] || warn "could not auto-detect the testbed docker network; set LOCAL_TESTBED_NETWORK and re-run the relay compose."
log "starting upload-relay + aggregator (network=${LOCAL_TESTBED_NETWORK:-<unset>})…"
dock compose -f "${RELAY_COMPOSE}" up -d || warn "gateways failed to start — check their logs."

health_check() { # <label> <url>
  if curl -fsS -o /dev/null --retry 8 --retry-delay 2 --retry-connrefused "$2" 2>/dev/null; then
    log "$1 reachable"
  else
    warn "$1 NOT reachable ($2) — it may be unhealthy. Check: sudo docker compose -f relay.compose.yml logs"
  fi
}
# Probe service liveness. The relay exposes prometheus metrics on :9184; its HTTP API on :57391
# doesn't guarantee a specific path responds without a valid request, so use the metrics endpoint.
# The aggregator exposes metrics on :27182. Both are best-effort warns only.
health_check "upload-relay metrics (:9184)" "http://127.0.0.1:9184/metrics"
health_check "aggregator (:27182)" "http://127.0.0.1:27182/metrics"

# 6. Emit the env contract consumed by every integration suite.
cat > "${LN_ENV_FILE}" <<EOF
# Generated by bootstrap-localnet.sh — DO NOT COMMIT. Sourced by the walrus integration suites.
export WALRUS_LOCALNET=1
export WALRUS_RPC_URL=${LN_RPC_URL}
export WALRUS_RELAY_HOST=${LN_RELAY_HOST}
export WALRUS_AGGREGATOR_HOST=${LN_AGGREGATOR_HOST}
export WALRUS_SYSTEM_OBJECT_ID=${SYSTEM_OBJECT}
export WALRUS_STAKING_POOL_ID=${STAKING_OBJECT}
export WALRUS_EXCHANGE_IDS=$(echo "${EXCHANGE_OBJECTS}" | tr '\n' ',' | sed 's/,$//')
export WALRUS_TEST_ADDRESS=${TEST_ADDR}
export WALRUS_TEST_SECRET_KEY=${TEST_SECRET}
export ACCESS_GATE_PACKAGE_ID=${AG_PACKAGE_ID:-}
export ACCESS_GATE_ID=${AG_GATE_ID:-}
EOF

log "wrote ${LN_ENV_FILE}"
log "done. Run:  set -a && source ${LN_ENV_FILE} && set +a  then  WALRUS_LOCALNET=1 npm run test:integration"
