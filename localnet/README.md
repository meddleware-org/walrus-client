# Walrus localnet e2e harness

The single source of truth for a **local Sui + Walrus network** that the Walrus packages
(`walrus-storage-client`, `walrus-storage-kit`, `walrus-storage-ui`) run their integration/e2e suites against. Nothing here
ships in the published `@meddleware/walrus-storage-client` package — it's a dev/CI harness.

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
scripts/down.sh  ──►  tears both down  (--clean also removes generated config, localnet/.sui + checkout)
```

The upstream `docker/local-testbed` is cloned (shallow, pinned) rather than re-authored here, so the
storage-node topology tracks upstream. The checkout is pinned by commit SHA (`WALRUS_REPO_REF`, default
the commit of `testnet-v1.56.0`; see "Upstream ref and images" below).

## Prerequisites

- Docker + Docker Compose v2, with **your user in the `docker` group** so the scripts run **without
  `sudo`**: `sudo usermod -aG docker $USER` then re-login (or `newgrp docker`). The scripts fail
  fast with this guidance if run as root (root-owned state would be left behind), and if the daemon
  is unreachable. Nothing escalates on its own: on a host without the group, opt in with
  `MW_ALLOW_SUDO=1` (docker then runs through `sudo -E docker`, and root-owned leftovers are removed
  with `sudo rm -rf`); without it the scripts stop and say what to do.
- `sui` CLI on `PATH`. Bootstrap never touches your `~/.sui`: it exports
  `SUI_CONFIG_DIR=localnet/.sui` (git-ignored), creates that config on first run, switches it to the
  `localnet` env and keeps the test address and the imported deploy-admin key there. To inspect the
  testbed with the CLI afterwards: `SUI_CONFIG_DIR=localnet/.sui sui client …`.
- The fixed deployer key in `scripts/lib.sh` is committed on purpose: it is a public key for the
  ephemeral testbed only. Never fund its address on testnet or mainnet.
- The `access-gate-sui` repo checked out as a sibling (`repos/access-gate-sui`). CI checks out the
  commit of its `v0.0.6` tag (`ACCESS_GATE_REF` repository variable overrides it); move the pin with
  the access_gate version the suite should deploy.

## Run

```bash
bash scripts/up.sh                 # no sudo
bash scripts/bootstrap-localnet.sh # no sudo — uses localnet/.sui, never ~/.sui
set -a && source .env.localnet && set +a       # export WALRUS_* for the suites

# then, in each repo:
cd ../ && WALRUS_LOCALNET=1 npm run test:integration          # walrus-storage-client
cd ../walrus-storage-kit && WALRUS_LOCALNET=1 npm run test:integration
cd ../walrus-storage-ui    && npm run test && npm run test:e2e

cd ../walrus-storage-client/localnet && bash scripts/down.sh
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
| `WALRUS_WAL_COIN_TYPE` | the WAL coin type of this testbed (`0x…::wal::WAL`), for balance checks |
| `ACCESS_GATE_PACKAGE_ID` / `ACCESS_GATE_ID` / `ACCESS_GATE_PLATFORM_CONFIG_ID` | localnet access_gate deployment (for the relay's gated path and purchase-terms read) |

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
  **testnet-only** while localnet ships no exchange object. Bootstrap therefore moves the WAL that
  `walrus-deploy` minted to its generated admin wallet over to `WALRUS_TEST_ADDRESS` (step 3b of
  `bootstrap-localnet.sh`). The lookups go through the **Sui CLI (gRPC)**, never the node's JSON-RPC:
  current Sui nodes no longer serve JSON-RPC (it answers 404), and the earlier `curl` lookups failed
  silently, leaving the wallet unfunded. The step is **fail-fast**: if the WAL cannot be found, the
  transfer fails, or the test address does not end up holding at least `LN_WAL_MIN_FROST`, bootstrap
  stops with a message naming the cause (the floor is `(storage_price × max epochs + write_price) ×
  units × margin`, from the prices in `scripts/lib.sh` that the deploy script also uses). The suites
  repeat the check against the live system object (`assertLocalnetWalFunded` in
  `tests/integration/harness.ts`) with the exact cost of what they are about to do, so an unfunded
  wallet reads "test wallet … holds 0 FROST of WAL but this suite needs …" instead of an opaque
  `Insufficient balance of …::wal::WAL` mid-suite. Blob *reads* need no WAL.

## Upstream ref and images

Everything the harness pulls is pinned by an immutable reference (tags can be moved or re-pushed):

| What | Pin | Override |
| --- | --- | --- |
| `MystenLabs/walrus` checkout (scripts, `docker/local-testbed`, contracts) | commit `a1899b9…` = tag `testnet-v1.56.0` | `WALRUS_REPO_REF` |
| walrus-service image | `mysten/walrus-service:testnet-v1.56.0@sha256:d4bf4ed…` | `WALRUS_IMAGE_NAME` (or `WALRUS_RELEASE_TAG`, which drops the digest) |
| upload-relay image | `mysten/walrus-upload-relay:testnet-v1.58.1@sha256:f8d3a10…` | `WALRUS_RELAY_IMAGE` |
| aggregator image | the walrus-service image above | `WALRUS_IMAGE_NAME` |
| Sui node image (`sui-localnet`) | `mysten/sui-tools:mainnet-v1.82.3@sha256:9dbefdc…` | `SUI_TOOLS_IMAGE` |

The upstream compose runs the Sui node from the **floating** `mysten/sui-tools:mainnet` tag; `testbed.override.yml`
replaces it with the digest above. The floating tag was the cause of the red nightlies of 2026-10-21/22: it moved
to a node that serves gRPC only, which broke the old JSON-RPC WAL lookup. Move the pin deliberately (the Sui CLI that
CI installs must still speak to it).

`scripts/up.sh` re-checks-out the pinned ref every run. To move to a new release, change the tag, SHA
and digest defaults in `scripts/lib.sh` together (`git ls-remote https://github.com/MystenLabs/walrus.git
refs/tags/<tag>`, and the image's index digest from the registry).

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
4. **Relay image** — `WALRUS_RELAY_IMAGE` (default: the digest-pinned `testnet-v1.58.1`) must exist for `mysten/walrus-upload-relay`.

The suites themselves are network-shape agnostic — they read only `.env.localnet`.
