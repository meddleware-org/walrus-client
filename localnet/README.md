# Walrus localnet e2e harness

The single source of truth for a **local Sui + Walrus network** that the Walrus packages
(`walrus-client`, `walrus-relay`, `walrus-ui`) run their integration/e2e suites against. Nothing here
ships in the published `@meddleware/walrus-client` package — it's a dev/CI harness.

## What it stands up

```text
scripts/up.sh  ──►  MystenLabs/walrus docker/local-testbed   (Sui validators + faucet + fullnode + 4 walrus nodes)
scripts/bootstrap-localnet.sh
      ├─ harvests the testbed's Walrus system/staking/exchange object ids
      ├─ writes generated/client_config.yaml  (a `localnet` context)
      ├─ funds an Ed25519 test keypair from the faucet
      ├─ deploys access_gate to localnet + creates a gate  (reuses ../../access-gate-sui/scripts/publish.sh)
      ├─ starts our upload-relay (relay.compose.yml, --context localnet)
      └─ writes .env.localnet   ← the contract every suite consumes
scripts/down.sh  ──►  tears both down  (--clean also removes generated config + checkout)
```

The upstream `docker/local-testbed` is cloned (shallow, pinned) rather than re-authored here, so the
storage-node topology tracks upstream. Pin the ref with `WALRUS_REPO_REF` (default `testnet-v1.53.0`,
aligned with the repo-root toolchain table).

## Prerequisites

- Docker + Docker Compose v2, with **your user in the `docker` group** so the scripts run **without
  `sudo`**: `sudo usermod -aG docker $USER` then re-login (or `newgrp docker`). This matters —
  `bootstrap-localnet.sh` uses *your* `sui` keystore, so running it under `sudo` (root's empty config)
  would fail the `access_gate` deploy. The scripts fail fast with this guidance if run as root.
- `sui` CLI on `PATH`, with a `localnet` env pointed at `http://127.0.0.1:9000`
  (`sui client new-env --alias localnet --rpc http://127.0.0.1:9000`). Bootstrap switches to it.
- The `access-gate-sui` repo checked out as a sibling (`repos/access-gate-sui`)

## Run

```bash
bash scripts/up.sh                 # no sudo
bash scripts/bootstrap-localnet.sh # no sudo — needs your sui keystore
set -a && source .env.localnet && set +a       # export WALRUS_* for the suites

# then, in each repo:
cd ../ && WALRUS_LOCALNET=1 npm run test:integration          # walrus-client
cd ../walrus-relay && WALRUS_LOCALNET=1 npm run test:integration
cd ../walrus-ui    && npm run test && npm run test:e2e

cd ../walrus-client/localnet && bash scripts/down.sh
```

## `.env.localnet` contract

The suites read these (via `set -a && source .env.localnet`):

| Var | Meaning |
| --- | --- |
| `WALRUS_LOCALNET` | `1` — gates the integration suites (unset ⇒ they skip) |
| `WALRUS_RPC_URL` | localnet Sui fullnode (`http://127.0.0.1:9000`) |
| `WALRUS_RELAY_HOST` | our upload-relay (`http://127.0.0.1:57391`) |
| `WALRUS_AGGREGATOR_HOST` | aggregator for read-back |
| `WALRUS_SYSTEM_OBJECT_ID` / `WALRUS_STAKING_POOL_ID` / `WALRUS_EXCHANGE_IDS` | harvested Walrus `packageConfig` (passed to `createWalrusClient({ walrusPackageConfig })`) |
| `WALRUS_TEST_ADDRESS` / `WALRUS_TEST_SECRET_KEY` | funded localnet keypair (bech32 `suiprivkey…`) |
| `ACCESS_GATE_PACKAGE_ID` / `ACCESS_GATE_ID` | localnet access_gate deployment (for the relay's gated path) |

## How this maps onto the upstream testbed (important)

The upstream `docker/local-testbed` is built for **internal storage-node testing**: it publishes no
host ports and ships no aggregator/publisher. This harness adapts it for host-driven tests:

- **`testbed.override.yml`** publishes the Sui fullnode (`9000`) + faucet (`9123`) to the host.
- **Object ids** are harvested from the `walrus-deploy-outputs` Docker **volume** (file
  `/opt/walrus/outputs/deploy`, `key: value` lines like `system_object: 0x…`) via a throwaway
  container — matching how the upstream `files/run-walrus.sh` extracts them. Non-ids like
  `exchange_object: None` (localnet has no WAL exchange) are filtered out.
- **Host blob I/O needs a gateway.** Storage nodes advertise their *internal* committee addresses
  (`10.0.0.10-13`), so a host process cannot read/write blobs by those addresses. `relay.compose.yml`
  runs two gateways on the testbed network with published ports: the **upload-relay** (`:57391`, the
  write path) and a **`walrus aggregator`** (`:57392`, the read path — read-only, no wallet/WAL).
- **Writes need WAL.** Storage reservation is paid in WAL, and `get-wal` (SUI→WAL exchange) is
  **testnet-only** while localnet ships no exchange object. So blob *reads* work out of the box, but
  *writes* require sourcing WAL to `WALRUS_TEST_ADDRESS` (e.g. from the deploy admin wallet / treasury)
  — the one remaining step for write-side integration coverage.

## Upstream ref (`WALRUS_REPO_REF`)

The harness pins a **release tag** for the scripts (`WALRUS_REPO_REF`, default `testnet-v1.55.2`) and
**overrides the walrus-service image to the matching tag** (`WALRUS_IMAGE_NAME`, default
`mysten/walrus-service:testnet-v1.55.2`). `scripts/up.sh` re-checks-out the pinned ref every run.

> **Why the patched deploy script is always on.** Docker image tags are mutable — `testnet-v1.55.2`
> initially pointed to a binary using `--contract-dir` (matching the upstream script), but later drifted
> to a binary expecting `--contract-path`. The upstream compose also hardcodes a stale image digest
> (`9eeee2f…`). Our patched `files/deploy-walrus.sh` (always applied via `MW_PATCH_DEPLOY=1`) uses
> `--contract-path` (current binary API) and mounts pinned-checkout contracts instead of cloning
> walrus-docs at deploy time (avoids Move compiler ICE from too-new contracts). Override
> `MW_PATCH_DEPLOY=0` only if testing with a verified internally-consistent image/script pair.

## First-run validation notes

1. **walrus-deploy must complete.** The storage nodes gate on it; `scripts/up.sh` waits for it and
   prints its log + aborts if it failed. If deploy fails, its log is the first thing to read.
2. **Testbed docker network name** — auto-detected as `local*testbed*`; override `LOCAL_TESTBED_NETWORK`
   if yours differs (standard: `local-testbed_testbed-network`).
3. **Deploy-outputs volume name** — auto-detected as `*walrus-deploy-outputs*`.
4. **Relay image tag** — `WALRUS_RELAY_TAG` (default `testnet`) must exist for `mysten/walrus-upload-relay`.

The suites themselves are network-shape agnostic — they read only `.env.localnet`.
