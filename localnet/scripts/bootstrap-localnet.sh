#!/usr/bin/env bash
# Harvest the testbed's Walrus network ids, generate an app-facing client config with a `localnet`
# context, fund a test keypair, deploy the access_gate Move package to localnet, bring up the
# upload-relay, and write `.env.localnet` — the single contract every integration suite consumes.
#
# Prerequisite: `bash scripts/up.sh` completed (testbed healthy).
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

# Run as YOUR normal user (NOT via sudo): the testbed Sui config under localnet/.sui must stay
# user-owned — docker access is per call (`dock` uses `sudo docker` only when you opt in with
# MW_ALLOW_SUDO=1 and are not in a docker group). Running the whole script under sudo would leave
# root-owned state behind.
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
  die "run this WITHOUT sudo:  bash scripts/bootstrap-localnet.sh
  (with MW_ALLOW_SUDO=1 the docker calls elevate themselves via sudo; you'll be prompted for your password.)"
fi

require docker
require sui
require curl

# Dedicated Sui CLI state (never the operator's ~/.sui): the env switch, the new test address and
# the admin-key import below all land in localnet/.sui (git-ignored), and the access_gate publish
# inherits it through the exported variable. `-y` creates the config on first use.
export SUI_CONFIG_DIR="${LN_SUI_CONFIG_DIR}"
mkdir -p "${SUI_CONFIG_DIR}"
log "using dedicated Sui config ${SUI_CONFIG_DIR}"

# The access_gate deploy (step 4) publishes to localnet, so point the testbed client there.
log "switching sui client to the localnet env"
if ! sui client -y switch --env localnet >/dev/null 2>&1; then
  log "no 'localnet' env found — creating it"
  sui client new-env --alias localnet --rpc http://127.0.0.1:9000 >/dev/null 2>&1 \
    || die "failed to create localnet sui env (is the localnet RPC at http://127.0.0.1:9000 reachable?)"
  sui client switch --env localnet >/dev/null 2>&1 \
    || die "localnet env was created but switch still failed — check sui client config"
fi

# Earlier sudo runs may have left generated/ or .env.localnet owned by root; this (non-sudo) run then
# can't overwrite them. Removing them needs sudo, so it happens only on explicit opt-in
# (MW_ALLOW_SUDO=1, the same switch `dock` uses); otherwise stop and say what to do.
for p in "${LN_GENERATED}" "${LN_ENV_FILE}"; do
  if [ -e "$p" ] && [ ! -w "$p" ]; then
    if [ "${MW_ALLOW_SUDO}" = "1" ]; then
      warn "removing root-owned $(basename "$p") left by a previous sudo run"
      sudo rm -rf "$p"
    else
      die "$(basename "$p") is root-owned (left by a previous sudo run) and cannot be overwritten. Remove it yourself (sudo rm -rf '$p') or re-run with MW_ALLOW_SUDO=1."
    fi
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
if [ -z "${SYSTEM_OBJECT}" ] || [ -z "${STAKING_OBJECT}" ]; then die "could not harvest system_object/staking_object from the deploy output. First lines of deploy:
$(printf '%s\n' "${DEPLOY_TXT}" | head -20)"; fi

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
# admin private key, find the WAL coin (through the Sui CLI — see lib.sh: the node serves gRPC only,
# JSON-RPC answers 404), transfer it to TEST_ADDR, then verify the test address really holds it.
# Every failure here is FATAL: a run that carries on without WAL only fails later in the suites with
# "Insufficient balance of …::wal::WAL", far from the cause (that is how the 2026-10-21/22 nightly
# went red).
log "sourcing WAL: reading deploy admin wallet from outputs volume (${VOL})…"
ADMIN_YAML="$(dock run --rm -v "${VOL}:${DEPLOY_OUTPUTS_MOUNT}:ro" busybox cat "${DEPLOY_OUTPUTS_MOUNT}/sui_admin.yaml" 2>/dev/null || true)"
# Parse active_address from the standard Sui client.yaml format (with or without quotes).
ADMIN_ADDR="$(printf '%s\n' "${ADMIN_YAML}" | sed -n 's/^active_address:[[:space:]]*["'"'"']\{0,1\}\(0x[0-9a-f]*\).*/\1/p' | head -1)"
# Parse keystore File: path; take just the filename since the path is absolute inside the container.
ADMIN_KEYSTORE_PATH="$(printf '%s\n' "${ADMIN_YAML}" | sed -n 's/.*File:[[:space:]]*//p' | head -1 | sed 's/[[:space:]]*$//')"
ADMIN_KEYSTORE_FILE="${ADMIN_KEYSTORE_PATH##*/}"  # basename via parameter expansion (no subshell)

if [ -z "${ADMIN_ADDR}" ] || [ -z "${ADMIN_KEYSTORE_FILE}" ]; then
  die "could not parse the deploy admin wallet from sui_admin.yaml (addr='${ADMIN_ADDR}', keystore='${ADMIN_KEYSTORE_FILE}'). First 15 lines:
$(printf '%s\n' "${ADMIN_YAML}" | head -15 | sed 's/^/  /')"
fi
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
[ -n "${ADMIN_KEY_ENTRY}" ] || die "could not extract the admin keystore entry from ${ADMIN_KEYSTORE_FILE} in the deploy-outputs volume"

LOCAL_KEYSTORE="${SUI_CONFIG_DIR}/sui.keystore"
[ -f "${LOCAL_KEYSTORE}" ] || die "local sui.keystore not found at ${LOCAL_KEYSTORE}"
python3 - "${ADMIN_KEY_ENTRY}" "${LOCAL_KEYSTORE}" <<'PYEOF' || die "could not add the admin key to ${LOCAL_KEYSTORE}"
import sys, json, os
entry, ks_file = sys.argv[1], sys.argv[2]
with open(ks_file) as f:
    ks = json.load(f)
if entry not in ks:
    ks.append(entry)
    tmp = ks_file + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(ks, f)
    os.replace(tmp, ks_file)
PYEOF
log "admin key injected into the testbed keystore (addr: ${ADMIN_ADDR})"

# walrus-deploy spends its SUI gas during contract publishing, leaving the admin wallet with
# insufficient gas for a transfer. Top it up from the localnet faucet first.
curl -fsS -X POST "${LN_FAUCET_URL}" -H 'Content-Type: application/json' \
  -d "{\"FixedAmountRequest\":{\"recipient\":\"${ADMIN_ADDR}\"}}" >/dev/null 2>&1 || true

# The WAL is normally at the admin. If not (a previous bootstrap on this same testbed already moved
# it, i.e. it ran twice without `down.sh --clean`), look at every other keystore address.
WAL_SOURCE_ADDR="${ADMIN_ADDR}"
WAL_COIN="$(wal_largest_coin "${ADMIN_ADDR}")"
if [ -z "${WAL_COIN}" ]; then
  log "WAL not at admin — scanning keystore addresses for WAL…"
  while IFS= read -r candidate; do
    [ -z "${candidate}" ] && continue
    [ "${candidate}" = "${ADMIN_ADDR}" ] && continue
    cand_coin="$(wal_largest_coin "${candidate}")"
    if [ -n "${cand_coin}" ]; then
      WAL_SOURCE_ADDR="${candidate}"
      WAL_COIN="${cand_coin}"
      log "found WAL at keystore address ${candidate}"
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
    # 1.8x prints [alias, address] pairs; older CLIs print objects or bare addresses.
    if isinstance(a, dict): addr = a.get('address', '')
    elif isinstance(a, list): addr = next((x for x in a if isinstance(x, str) and x.startswith('0x')), '')
    else: addr = a
    if addr: print(addr)
except Exception: pass
" 2>/dev/null || true)
fi
[ -n "${WAL_COIN}" ] || die "no WAL coin found at the deploy admin ${ADMIN_ADDR} or any other keystore address — the testbed cannot fund blob writes. (Checked with 'sui client balance', i.e. over gRPC; is the localnet at ${LN_RPC_URL} up and is the sui CLI pointed at it?)"
read -r WAL_COIN_TYPE WAL_COIN_OBJ WAL_COIN_AMOUNT <<< "${WAL_COIN}"
log "WAL source ${WAL_SOURCE_ADDR}: coin ${WAL_COIN_OBJ} holds ${WAL_COIN_AMOUNT} FROST (${WAL_COIN_TYPE})"
(( WAL_COIN_AMOUNT >= LN_WAL_MIN_FROST )) \
  || die "the WAL coin (${WAL_COIN_AMOUNT} FROST) is below the ${LN_WAL_MIN_FROST} FROST the suites may need ((storage ${LN_STORAGE_PRICE} x ${LN_WAL_MAX_EPOCHS} epochs + write ${LN_WRITE_PRICE}) x ${LN_WAL_MAX_UNITS} units x ${LN_WAL_MARGIN} margin)."

sui client switch --address "${WAL_SOURCE_ADDR}" >/dev/null 2>&1 || true
ACTIVE_ADDR="$(sui client active-address 2>/dev/null || true)"
[ "${ACTIVE_ADDR}" = "${WAL_SOURCE_ADDR}" ] \
  || die "address switch failed (wanted ${WAL_SOURCE_ADDR}, got ${ACTIVE_ADDR:-unknown}) — cannot sign the WAL transfer"
# `sui client transfer-object` was removed in newer Sui CLI versions: use a PTB to transfer the coin.
if ! TRANSFER_OUT="$(sui client ptb \
  --transfer-objects "[@${WAL_COIN_OBJ}]" "@${TEST_ADDR}" \
  --gas-budget 50000000 2>&1)"; then
  die "WAL transfer ${WAL_SOURCE_ADDR} -> ${TEST_ADDR} failed:
$(printf '%s\n' "${TRANSFER_OUT}" | head -15 | sed 's/^/  /')"
fi

# Verify the delivery: the test address must now hold at least the floor (allow a few seconds for the
# fullnode to index the transfer).
WAL_TEST_TOTAL=0
for _ in $(seq 1 15); do
  WAL_TEST_TOTAL="$(wal_total "${TEST_ADDR}")"
  (( WAL_TEST_TOTAL >= LN_WAL_MIN_FROST )) && break
  sleep 2
done
(( WAL_TEST_TOTAL >= LN_WAL_MIN_FROST )) \
  || die "WAL funding did not arrive: test address ${TEST_ADDR} holds ${WAL_TEST_TOTAL} FROST, needs at least ${LN_WAL_MIN_FROST}."
log "WAL funded: ${TEST_ADDR} holds ${WAL_TEST_TOTAL} FROST (floor ${LN_WAL_MIN_FROST})"
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
AG_PLATFORM_CONFIG_ID="$({ grep -oE 'ACCESS_GATE_PLATFORM_CONFIG_ID=0x[0-9a-f]+' "${AG_ENV}" || true; } | cut -d= -f2 | head -1)"

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
export WALRUS_WAL_COIN_TYPE=${WAL_COIN_TYPE}
export ACCESS_GATE_PACKAGE_ID=${AG_PACKAGE_ID:-}
export ACCESS_GATE_ID=${AG_GATE_ID:-}
export ACCESS_GATE_PLATFORM_CONFIG_ID=${AG_PLATFORM_CONFIG_ID:-}
EOF

log "wrote ${LN_ENV_FILE}"
log "done. Run:  set -a && source ${LN_ENV_FILE} && set +a  then  WALRUS_LOCALNET=1 npm run test:integration"
log "(the testbed's Sui CLI state is in ${SUI_CONFIG_DIR}; use it with: SUI_CONFIG_DIR=${SUI_CONFIG_DIR} sui client …)"
