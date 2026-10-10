# Security Audit — `walrus-client`

**Classification:** Internal security review (initial audit — awaiting external review)
**Project:** walrus-client (`@meddleware/walrus-client`) — the Walrus storage SDK layer for the apps.
  - **SDK surface:** a client factory over `@mysten/walrus`, with upload-relay wiring, a tip cap and a
    relay-auth `fetch` hook.
  - **Uploads and management:** quilt and raw-blob uploads; lifetime and attribute management;
    owned-blob queries.
  - **Gated access:** helpers for the nft-gate relay access proof.
  - **`./flow`:** the headless register → upload → certify orchestrator, with single-use relay access
    and resume state.
  - **`./http`:** a wasm-free publisher/aggregator client.
  - **`localnet/`:** a dev/CI testbed harness.

**Project type:** TS SDK (npm package; ships TypeScript source, no build step) + localnet CI harness
(shell + Docker Compose)
**Template:**

- AUDIT_TEMPLATE.md (2026-10-08)
- AUDIT_TEMPLATE_WALRUS.md (2026-09-30)
- AUDIT_TEMPLATE_SUI_CLIENT.md (2026-10-08)
- AUDIT_TEMPLATE_TS.md (2026-10-08)
- AUDIT_TEMPLATE_OPS.md (2026-10-08) — applied to the localnet harness and the integration workflow
  only. They sign on an ephemeral localnet, never on a real chain.

Not triggered: AUTH (this package issues, verifies and decides nothing: it injects a caller-supplied
relay token and asks `@meddleware/nft-gate-client` to sign the access proof; the signed-challenge
design is audited in `nft-gate-client-audit.md`), SEAL (no encryption here), VUE, WORKERS, IMG (no
container image), PROXY, GO, RUST, SITE, PLATFORM.

**Deployment status:**

- npm `@meddleware/walrus-client` **0.0.27** (2026-10-09), published from tag `v0.0.27` = `83521fc`,
  which is HEAD of `main`. It carries an SLSA v1 provenance attestation (checked on the registry
  2026-10-09). `main` holds no unreleased code change.
- Consumed at `^0.0.27` by walrus-ui, walrus-relay, token-deployer-ui and seal-ui (`./http`), and at
  `^0.0.26` by the docs site (which does not list owned blobs, so it is not affected by F23).
- Depends on `@meddleware/nft-gate-client` `^0.0.16` (audience-bound `nft-gate:access:v2` proofs).
- The live gated path is walrus-ui and token-deployer-ui → `runBlobUpload` + `createGatedAccess` →
  nft-gate Workers gateway → operator relay (testnet). Operator-relay paywall e2e PASSED 2026-10-09
  against the live dashboard: a pass was bought on gate `0x316f1bf9…`, consumed, an
  `nft-gate:access:v2` proof was signed, and the upload went through the Worker.
- The localnet integration suite PASSED again on 2026-10-09 after the 0.0.27 fix.

**Review date:** 2026-10-03, re-verified 2026-10-09
**Reviewer:** Internal review
**Severity ceiling:** High.

- `./flow` drives transactions that pay SUI and WAL (storage, relay tip, gas), and spends single-use
  access passes.
- `relayAuthFetch` carries the access proof.
- A flaw can double-charge users, burn passes, or leak a proof to another origin.
- Realised ceiling at the first pass: **Medium** (F7). Realised ceiling now: nothing open above Info
  (F7 and F23 are RESOLVED).

**Status:** re-verified 2026-10-09 (first in-repo pass 2026-10-03).

**Finding IDs.** The tests cite three findings of an earlier workspace-corpus audit ("walrus-audit"):

| ID | Subject |
| --- | --- |
| F2 | `disableUploadRelay` |
| F4 | no token over plain http |
| F6 | the token is scoped to the relay hook |

These IDs and meanings are preserved below. The corpus file itself was not available to the first
pass, so new findings start at **F7**. If the corpus file used F7 or above, renumber the new findings
when you relocate it, and leave a pointer stub at the corpus path. The 2026-10-09 re-verification adds
**F23** (positive findings keep F20–F22; F23 onwards are new).

**Package manager / lockfile:** npm; `package-lock.json` committed. No `.npmrc`: `legacy-peer-deps`
was removed in 0.0.26 (F9).
**Module format:** ESM.
**Publish model:** ships TS source. There is no `.d.ts` and no `types` condition (F18). `files` is
`src` and `CHANGELOG.md` (`npm pack --dry-run` 2026-10-09: 14 files, 30.9 kB). `exports`:

- `"."` → `src/index.ts`
- `"./flow"` → `src/flow.ts`
- `"./http"` → `src/http.ts`
- `"./node"` → `src/node.ts`

**Runtime targets:** browsers via Vite; Node 24 LTS (CI, workspace decision; no `engines` field, F18).
**Peer dependencies:** `@mysten/sui` `^2.33.2` and `@mysten/walrus` `~1.2.32` (since 0.0.26; both are
also devDependencies).

**Dependencies:**

| Package | Range | Installed | Notes |
| --- | --- | --- | --- |
| `@mysten/sui` | peer `^2.33.2`; dev `^2.35.0` | 2.35.0 | satisfies `@mysten/walrus`'s peer (F9) |
| `@mysten/walrus` | peer `~1.2.32`; dev `~1.2.32` | 1.2.34 | 1.2.34 is the latest release |
| `@meddleware/nft-gate-client` | `^0.0.16` | 0.0.16 | latest; the only runtime dependency |
| `@mysten/walrus-wasm` | transitive | 0.3.1 | via `@mysten/walrus` |

**Sui SDK / transport:** `SuiGrpcClient` (gRPC-web) for the Walrus client; structural core-API
clients elsewhere. No JSON-RPC.

**SUI_CLIENT lens front matter:**

- **Networks:** testnet and mainnet (SDK-bundled configs) and localnet (caller-supplied config).
- **On-chain packages consumed:** none hardcoded. The Walrus system and staking objects come from the
  SDK's `TESTNET_/MAINNET_WALRUS_PACKAGE_CONFIG` or the caller's `walrusPackageConfig` (localnet,
  harvested). The Blob type is resolved at run time (`getBlobType()`). The `access_gate` consume
  transaction is built by the caller and injected (`buildConsume`, from access-gate-client). The gate
  id and network are inputs signed into each proof.

**WALRUS lens front matter:**

- **Walrus SDK:** `@mysten/walrus` `~1.2.32` (installed 1.2.34); `@mysten/walrus-wasm` 0.3.1.
- **Package config source:**
  - testnet and mainnet: SDK-bundled `TESTNET_/MAINNET_WALRUS_PACKAGE_CONFIG`;
  - localnet: caller-supplied `walrusPackageConfig`, harvested by `localnet/scripts/bootstrap-localnet.sh`.
- **Upload relays:**
  - public defaults `https://upload-relay.testnet.walrus.space` and
    `https://upload-relay.mainnet.walrus.space`;
  - the operator relay is caller-supplied (walrus-ui / token-deployer-ui `VITE_WALRUS_RELAY_*`, gated
    by nft-gate).
- **Aggregators:** `https://aggregator.walrus-testnet.walrus.space` and
  `https://aggregator.walrus-mainnet.walrus.space`.
- **Publisher:** caller-supplied (`./http`). Walrus runs no public mainnet publisher.
- **Tip ceiling:** `DEFAULT_UPLOAD_RELAY_MAX_TIP_MIST = 50_000_000` (0.05 SUI), in `src/client.ts:176`.
  Callers override it with `uploadRelayMaxTipMist`. It is enforced by the SDK (`sendTip.max`).
- **Epoch default / maximum:** 53 / 53. `epochs` is validated as an integer in `[1, max]`, where `max`
  is the live `max_epochs_ahead` read through the SDK with `MAX_SINGLE_RESERVATION_EPOCHS = 53` as the
  fallback (F10, `src/limits.ts`).
- **Deletable default:** **permanent** (`deletable: false`) on every path. Pointers and manifests must
  stay readable until expiry. The consequence for users: a stored blob cannot be removed by its owner.

**OPS lens front matter (localnet harness only):**

- **CLI tools:**
  - sui `testnet-v1.81.0` in `integration.yml`, installed through a sha256-pinned `suiup` v0.0.14 and
    checked against the binary's sha256 (matches the Move repos' `Published.toml`; F17);
  - Docker Compose v2;
  - the upstream `MystenLabs/walrus` checkout at `testnet-v1.56.0` (a tag);
  - images `mysten/walrus-service:testnet-v1.56.0` and `mysten/walrus-upload-relay:testnet` (mutable
    tags).
- **Networks:** localnet only.
- **Key material:**
  - a committed, deliberately public localnet deployer key (`localnet/scripts/lib.sh:78-82`, F17);
  - a faucet-funded test keypair generated per run into the git-ignored `localnet/.sui` and
    `.env.localnet`;
  - the walrus-deploy admin key read from a Docker volume.

- **Networks targetable:** localnet only.

**Location:** `walrus-client/docs/audit/walrus-client-audit.md`. This is a new directory; see the
finding-IDs note above.

---

## Executive summary

`@meddleware/walrus-client` is 1,761 lines in 10 modules, plus a localnet harness (about 780 lines of
shell and Compose). The first pass (2026-10-03, v0.0.25) recorded F7–F22 and changed nothing; between
2026-10-08 and 2026-10-09 the maintainer released 0.0.26 and 0.0.27, which resolve the actionable
findings. This 2026-10-09 re-verification re-read every finding against `main` (`83521fc`, v0.0.27).

**Core disciplines are in place and well tested:**

- **Relay authentication** goes through the only option the SDK honours (a `fetch` hook). It is
  origin-scoped and resolved per request, refused over non-loopback http, and never patches
  `globalThis.fetch` (F2/F4/F6, F20). A hermetic test now proves the real SDK calls the hook (F13).
- **The upload flow:**
  - registers fresh on every attempt (register is never resumed across loads: the tip relay embeds
    the tip and a nonce in the register transaction and rejects an old one as "too old");
  - spends and persists the single-use consume (`{ digest, nftId, savedAt }`, validated on reuse)
    before register, and mints the signed token after register, before each upload attempt;
  - retries a failed upload on the same registration, bounded (3 attempts, 50 minutes), and attaches
    `uploadRetry` when attempts run out (F7);
  - re-consumes only on the gateway's `409 redeemed` (or one rejected resumed consume);
  - retries certify without re-uploading;
  - checks for an existing copy before registering.
- **Owned-blob listings** page with a bound, match the exact Blob type and never invent values. Since
  0.0.27 they accept a real u256 blob id (F23).
- **`./http`** is https-only, refuses redirects, caps response bodies, reports whether the publisher
  created a Blob for you, and has timeouts and a streamed read cap.
- **The lazy wasm boundary holds:** `./flow` imports the package root only dynamically.

**Measured (2026-10-09, Node 24.13.0):**

- 105/105 unit tests (8 files); tsc, eslint and `npm audit --audit-level=high` (0) clean;
- `npm ls --all` passes (the 0.0.25 invalid peer is gone);
- shellcheck not installed in this sandbox (it runs in Node CI); coverage not re-measured (the
  coverage plugin is not installed), so the 2026-10-03 figures are historical.

**Findings by final disposition (21 findings: F2, F4, F6 and F7–F24; 18 carry a disposition, F20–F22 are Positive):**

| Disposition | Findings |
| --- | --- |
| RESOLVED | F2, F4, F6, F7, F8, F9, F10, F11, F12, F23 |
| MITIGATED | F13, F17 (key: ACCEPTED-RISK) |
| ADJUDICATED | F19 |
| ACCEPTED-RISK | F14, F15, F16, F24 |
| DEFERRED | F18 (pre-mainnet packaging gate; OQ3 is a maintainer decision) |
| Positive | F20, F21, F22 |

**What changed since the first pass:**

1. **F7 (Medium) is RESOLVED.** A failed upload no longer costs a second paid registration: the token
   is minted after register and the upload is retried on the same registration (0.0.26, `d1bb9cc`).
2. **F23 (Medium, new, RESOLVED).** `fetchOwnedWalrusBlobs` returned no blobs on a live network in
   0.0.23–0.0.26 (a u256 blob id was capped at 20 digits). Fixed in 0.0.27 (`83521fc`); the daily
   localnet suite caught it.
3. **Low findings F8–F13** are resolved or mitigated: consume storage validated, peer dependencies
   declared, inputs validated, `./http` hardened, `SECURITY.md` corrected, the SDK-honours-`fetch`
   test added.
4. **Open items are Info or process:** F14–F16 (accepted), F17 (localnet harness pins, mitigated),
   F18 (packaging, deferred to the pre-mainnet gate) and F24 (the nightly localnet suite is neither
   alerted on nor a release gate).

---

## Threat model / trust boundaries

### Walrus trust matrix (WALRUS lens, mandatory)

| Party | Power | Consequence / bound | Here |
| --- | --- | --- | --- |
| Storage-node committee | stores slivers; signs availability | Byzantine-tolerant (2f+1 shards per certificate) | SDK; certify is on-chain-validated |
| Upload relay operator (public or operator) | receives the **plaintext** blob; publishes the tip config; no on-chain action | sees content; may request any tip | tip bounded by `sendTip.max` (SDK); content public by design (WAL-M7, F12) |
| Gateway in front of the operator relay | admits uploads carrying an access proof | bypass if the relay is reachable directly (nft-gate / WORKERS lens) | client attaches the proof only to the relay origin (F6) |
| Aggregator | serves bytes for a blob id | can serve wrong bytes unless checked | `strict_consistency_check=true` is the aggregator's own check; no local re-derivation; the trust is now documented (F11, `SECURITY.md`) |
| HTTP publisher | stores with its own wallet | owns the Blob unless `send_object_to` | `sendObjectTo` is required; the `alreadyCertified` path creates no user-owned Blob, and `PublishResult.kind` now says so (F11) |
| Walrus system package / WAL | pricing and epochs | cost and expiry | `estimateStorageCost`; `max_epochs_ahead` read live, 53 fallback (F10) |
| User wallet | pays SUI + WAL; signs register, certify, extend and the access message | owns the Blob on the relay path | `owner: deps.address`; sender set on both transactions |
| Browser storage (same origin) | resume state: consume record, pending certificates | tampering or stale state | pending certificates validated per entry; the consume record is validated (format, pass, age) and dropped otherwise (F8) |

### Supply chain & input matrix (TS lens)

| Actor / source | Controls | Bounded by |
| --- | --- | --- |
| Dependency authors | `@mysten/walrus` (+ wasm), `@mysten/sui`, `@meddleware/nft-gate-client` | lockfile; `npm audit` in CI and publish; peer ranges declared and checked by `npm ls --all` in CI (F9); weekly grouped Dependabot. |
| Registry | tarballs | lockfile integrity; provenance on publish |
| Relay responses | tip config, upload result, errors (`409 redeemed`) | SDK tip cap; `isRedeemedConflict` (bounded cause depth) |
| Aggregator / publisher responses | bytes, JSON, errors | https, timeouts, read cap, 64 KiB cap on publisher bodies, blob-id regex, redirects refused (F11) |
| Full node | owned-object pages, object JSON | page bound; exact type; strict field parsing |
| Caller inputs | epochs, tip cap, hosts, storage scheme, blob ids | epochs and tip cap validated before any prompt (F10); host and storage-scheme edge cases accepted (F14) |

### On-chain dependency matrix (SUI_CLIENT lens)

| Object / package | ID per network | Sourced from | Used as | If stale, wrong or attacker-supplied | Fails open / closed |
| --- | --- | --- | --- | --- | --- |
| Walrus system and staking objects | testnet, mainnet: SDK-bundled; localnet: harvested by `bootstrap-localnet.sh` | `@mysten/walrus` config or caller `walrusPackageConfig` | call targets inside SDK-built transactions | register or certify against the wrong deployment; the package tracks upgrades only through SDK releases | closed (localnet requires an explicit config and RPC) |
| Walrus `Blob` type | resolved at run time (`getBlobType()`) | SDK | type filter in `fetchOwnedWalrusBlobs`, re-checked after normalisation | look-alike type listed | closed (exact type, F22) |
| `access_gate` consume | per caller | caller-injected `buildConsume` (access-gate-client) | the single-use consume transaction | wrong gate or package: the gateway rejects the proof | closed |
| Gate id and network | per caller | `GatedAccessPorts.gateId` / `network` | signed into every `nft-gate:access:v2` proof | a proof for the wrong gate or network is refused by the gateway | closed |

Actors added by the lens: the **RPC fullnode** (can lie about or withhold owned objects and effects;
bounded by the exact-type and strict-field parsing, and by awaiting finality before dependent steps),
and the **wallet** (what it displays and signs; the executor port is the app's).

### Operations matrix (OPS lens — localnet harness)

| Actor / asset | Power | Bounded by |
| --- | --- | --- |
| Operator machine running `up.sh` / `bootstrap-localnet.sh` | Docker (falls back to `sudo -E docker`), sui CLI | dedicated `SUI_CONFIG_DIR=localnet/.sui` (never `~/.sui`); refuses to run bootstrap under sudo |
| Committed deployer key (`lib.sh:78-82`) | controls `0x2224…838c` on any chain where it is funded | documented as public and localnet-only — never fund it elsewhere (ACCEPTED-RISK, F17) |
| CI runner (`integration.yml`) | nightly localnet run; `GITHUB_TOKEN` (contents: read) for suiup | no real-chain keys; suiup and the sui binary are checksum-pinned; `access-gate-sui@main` and mutable image tags remain (F17) |
| Upstream images / checkout | the code the testbed runs | tag-pinned only (F17) |

### Script inventory (OPS lens)

| Script | Signs? | Objects touched | Irreversible? | Dry-run default | Confirmation | Network guard | Writes IDs to |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `localnet/scripts/up.sh` | no (Compose up; key file generated) | testbed containers and volumes | no | n/a | none | localnet only (local Docker) | `generated/deployer-sui-config/` |
| `localnet/scripts/bootstrap-localnet.sh` | **yes, on localnet** (WAL transfer, faucet, `access-gate-sui/scripts/publish.sh localnet --create-gate`) | test address, WAL coin, `access_gate` package + gate | localnet-ephemeral | n/a | none | dedicated `SUI_CONFIG_DIR`; switches only that config to `localnet` | `.env.localnet` (git-ignored) |
| `localnet/scripts/down.sh [--clean]` | no | containers, volumes; `--clean` removes generated state (may `sudo rm -rf`) | local only | n/a | none | local | — |
| `localnet/files/deploy-walrus.sh` (mounted into walrus-deploy) | yes, inside the container on localnet | Walrus system objects | localnet-ephemeral | n/a | none | container network | the deploy-outputs volume |

---

## Severity scale

Critical / High / Medium / Low / Info / Positive (unchanged across the corpus).

## Scope

**In scope (HEAD `83521fc` = tag `v0.0.27`, re-verified 2026-10-09; the first pass read `942c36a` = `v0.0.25`):**

- `src/{index,client,access,upload,manage,query,flow,http,limits,node}.ts`
- `tests/**` (8 unit files, integration harness + lifecycle suite)
- `localnet/**` (scripts, Compose overrides, relay config, committed deployer `client.yaml`, README)
- `package.json`, `package-lock.json`, `tsconfig.json`, `vitest*.config.ts`,
  `eslint.config.ts`, `.gitignore` (`.npmrc` was removed in 0.0.26)
- `README.md`, `SECURITY.md`, `CLAUDE.md`, `AGENTS.md`, `CHANGELOG.md`
- `.github/workflows/{node-ci,npm-publish,integration}.yml`, `.github/dependabot.yml`

**Cross-repo evidence (read-only):**

- nft-gate `gateway-workers` (`CHALLENGE_TTL_SECS = 300`, `wrangler.toml:59`; `config.ts:204`);
- walrus-ui `WalrusView.vue:133-168` (`findExistingCopy`, pending-certify wiring);
- token-deployer-ui CLAUDE.md (live gated-relay e2e passed 2026-10-01; relay freshness one hour);
- `@meddleware/nft-gate-client` 0.0.15 at the first pass, 0.0.16 now (challenge timeout, audience-bound
  proof encoding);
- the registry (provenance of 0.0.27) and the consumers' `package.json` ranges (2026-10-09).

**Out of scope:**

- `@mysten/walrus` internals (tip enforcement, relay protocol, encoding);
- the relay, gateway and aggregator services;
- the consuming apps (own audits; facts cited).

**Environment / commands (2026-10-09, Node 24.13.0; the first-pass 2026-10-03 results on Node 22.22.2 are kept in the log):**

| Command | Result |
| --- | --- |
| `npx vitest run` | **105 passed** (8 files); 2026-10-03 was 81 passed (7 files) |
| `npx tsc --noEmit` / `npx eslint .` | clean / clean |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| `npm ls --all` | exit 0 (sui 2.35.0 and walrus 1.2.34 satisfy the declared peers). 2026-10-03: `ELSPROBLEMS`, `@mysten/sui@2.33.1` invalid (F9) |
| `npm pack --dry-run` | 14 files, 30.9 kB (`src/**` incl. `limits.ts`, `CHANGELOG.md`, `README.md`, `LICENSE`, `package.json`). No `SECURITY.md` and no `localnet/` (F18). |
| `npm view @meddleware/walrus-client` | latest 0.0.27; SLSA v1 provenance attestation present on 0.0.27 |
| `shellcheck …` | not installed in this sandbox. 2026-10-03: clean (0.11.0). Still a Node CI job. |
| `npx vitest run --coverage` | not re-measured (plugin not installed). 2026-10-03 (historical): 90.36% statements / 85.01% branches / 86.79% functions / 93.18% lines; `manage.ts` 45.83%, `upload.ts` 73.33%. 0.0.26 added tests for exactly those gaps (F13) |
| `npm run test:integration` (localnet testbed) | **not run here** (no Docker testbed in this sandbox). Maintainer run log: red from 2026-10-02 (F23), **PASS again on 2026-10-09** after the 0.0.27 fix |

The working tree was not modified by this pass beyond this file (`docs/` is untracked in the repo).

---

## Findings

### F2 — `disableUploadRelay` (corpus ID)

**Severity:** Info   **Disposition:** RESOLVED (carried from the corpus; re-verified 2026-10-09)

- `disableUploadRelay` wins over both an explicit host and the public fallback (`client.ts:133-135`).
- localnet with no host builds no relay.
- Tests:
  - `disableUploadRelay builds a relay-less client (walrus-audit F2)`;
  - `disableUploadRelay overrides an explicit host`;
  - `localnet without an explicit relay host builds no upload relay`.

**Remediation / evidence (2026-10-09):** Unchanged and still pinned: `disableUploadRelay` is applied in `createWalrusClient` (`src/client.ts`), and the three tests above pass in `tests/client.test.ts` (105/105 on 2026-10-09). The first-pass line citation (`client.ts:133-135`) has moved; the logic is the same.

### F4 — Auth token over plain http (corpus ID)

**Severity:** Medium (at the time)   **Disposition:** RESOLVED (carried; re-verified 2026-10-09)

- `relayAuthFetch` throws rather than send a token to a non-https relay URL; loopback http is allowed
  (`client.ts:198-202`).
- Test: `F4: relay fetch hook throws when auth token would be sent over http`.

**Remediation / evidence (2026-10-09):** Unchanged: `relayAuthFetch` (`src/client.ts`) still throws for a non-https, non-loopback target when a token is present; the test is `tests/client.test.ts` "F4: relay fetch hook throws…". Line numbers moved (first-pass `client.ts:198-202`).

### F6 — Token scope (corpus ID)

**Severity:** Medium (at the time)   **Disposition:** RESOLVED (carried; re-verified 2026-10-09)

- The token is injected only through the relay's own `fetch` option.
- The Authorization header is added only when `target.origin === relayOrigin`.
- `globalThis.fetch` is never patched.
- Tests:
  - `F6: auth token is scoped to the relay fetch hook only — globalThis.fetch is not patched`;
  - `never attaches the token to a request for another origin`.

**Remediation / evidence (2026-10-09):** Unchanged, and now also proven against the real SDK: `tests/relay-auth-sdk.test.ts` drives the real `@mysten/walrus` client with a stubbed global `fetch` and asserts `Authorization: Bearer <current token>` on the relay request and on no other origin (see F13).

### F7 — An upload failure after register forces a second paid registration; the gated token can expire during register

**Severity:** Medium   **Disposition:** RESOLVED (0.0.26, `d1bb9cc`; OQ1 decided, see below)
**Where:**

- `src/flow.ts:397-448` (`runBlobUpload`): the token is minted at `:402-405`, before encode
  (`:418`) and register (`:429-435`); the same-registration retry is only on `isRedeemedConflict`
  (`:441-448`).
- nft-gate `gateway-workers/wrangler.toml:59` (`CHALLENGE_TTL_SECS = "300"`).

**Issue:**

1. **Every failure but a 409 propagates.** After register (storage reservation, relay tip and gas
   paid; Blob object created), any upload failure other than a 409 propagates out of
   `runBlobUpload`. Examples: a relay 5xx, a network drop, a gateway `401` for an expired or invalid
   nonce, a timeout.
2. **There is no recovery for the registration.** The live `flow` holding that registration is
   dropped. Nothing is persisted for "registered, not uploaded" (only the post-upload certificate is).
   There is no `uploadRetry` counterpart to `certifyRetry`.
3. **The app's retry pays again.** Its only recovery is to call `runBlobUpload` again, which by design
   **registers fresh**: storage, tip and gas are paid again. The first Blob stays owned, uncertified
   and never uploaded.
4. **walrus-ui's precheck cannot see it.** `findExistingCopy` only reports certified copies, or
   pending copies that *were* uploaded (from the pending-certify store), so it does not detect the
   orphan.
5. **Gated uploads hit this routinely.** `access.token(false)` fetches the gateway challenge
   (**300 s TTL**), performs the single-use consume, and signs — all **before** encoding the content
   and before the register wallet approval and its confirmation wait.
   - A large file's encode, a user who takes a few minutes to approve register, or a slow
     confirmation pushes the upload past the challenge's expiry.
   - The gateway then rejects with a non-409 error, after register has been paid.
   - The consume digest is safe (persisted), but the storage and tip are lost.

The code already relies on the relay accepting a retry on the same registration (the 409 path, "still
recent registration"). Per the relay's default, the tip transaction stays fresh for one hour. So a
same-registration retry is possible; it is simply not offered for other failures.

**Impact:**

- Users pay storage, tip and gas twice, or more, for one upload.
- They accumulate orphaned, unusable Blob objects.
- This contradicts WAL-M8 ("never pays twice") and the README's "fresh register every attempt"
  rationale, which assumes the earlier registration is unusable.

**Original remediation (first pass):**

1. Mint or refresh the access token **after register**, immediately before `flow.upload`. The consume
   may stay before register, since its digest is persisted.
2. On any upload failure within the relay's freshness window:
   - retry on the same registration;
   - for a gated relay, first call `access.token(false)` for a fresh challenge and signature (no new
     consume);
   - bound the attempts.
3. Attach an `uploadRetry` closure to the thrown error (as `certifyRetry` does), so a widget can
   offer "Retry upload" without re-registering.
4. Optionally persist `{ blobObjectId, registerDigest, savedAt }` so a reload within the window can
   resume. Otherwise surface the orphan for the user to delete (impossible when permanent) or
   document it.
5. Add tests:
   - an expired-challenge rejection retries on the same registration with a fresh token;
   - a relay 5xx retries without a second `signAndExecute(register)`.

**Remediation / evidence (2026-10-09):** RESOLVED in 0.0.26 (commit `d1bb9cc`, CHANGELOG 2026-10-08). The `src/flow.ts` line numbers in **Where** are the first pass's; the code is now `runBlobUpload` (`attempt`, `uploadWithRetries`) in the same file.

- **Token minted after register.** `attempt()` calls `access.token()` right before each `flow.upload`, so a slow encode or wallet approval no longer outlives the gateway challenge (300 s). The single-use consume is still spent and persisted before register (`access.prepare()`).
- **Same-registration retry, bounded.** `uploadWithRetries` retries up to `UPLOAD_ATTEMPTS = 3` (backoff `2 s × n`) while `now - registeredAt <= REGISTRATION_FRESH_MS` (50 minutes, inside the relay's one-hour freshness). It retries for a `409 redeemed` (spends a new use), one rejected resumed consume (403), a `409 leased`, a stale proof (401/403 about nonce or signature), 429, 5xx and network errors (fresh token each time, no new consume). Any other 4xx is final.
- **`uploadRetry`.** When attempts run out inside the window, the thrown error carries `getUploadRetry(err)` (the counterpart of `certifyRetry`). It is consumed by token-deployer-ui (`IconPicker.vue`) and walrus-relay (`WalrusUpload.vue`, which walrus-ui uses).
- **Tests (`tests/flow.test.ts`):** "spends the consume before register, mints the token AFTER register, and threads it into the relay"; "a relay 5xx or a network error retries on the same registration with a fresh token, no new consume"; "an expired-challenge rejection retries on the same registration with a fresh token"; "bounds the retries and hands the caller an uploadRetry on the same registration"; "does not retry once the registration is too old for the relay"; "does not retry a rejection that is not about the proof"; "an open relay also retries transient failures on the same registration".
- **Decision on OQ1 (b), persisting "registered, not uploaded" state: not adopted.** Register is never resumed across page loads: the tip relay embeds the tip and a per-encode nonce in the register transaction and rejects a reused one as "the received transaction is too old", and the SDK flow that holds the encoded slivers lives in memory. So `uploadRetry` is an in-memory closure, and the flow's invariant stays "register fresh on every new attempt" (CLAUDE.md).
- **Residual, ACCEPTED-RISK (same reason):** closing or reloading the page between register and a landed upload still orphans one paid, uncertified Blob (permanent, so not deletable), and walrus-ui's `findExistingCopy` does not report it. The window is now the minutes of an interrupted session, not every transient relay error.

### F8 — A stored consume digest is never validated or expired; a bad one blocks gated uploads indefinitely

**Severity:** Low   **Disposition:** RESOLVED (0.0.26, `d1bb9cc`)
**Where:** `src/flow.ts:272-305` (`createGatedAccess`): `storage.getItem(key)` is reused verbatim;
it is cleared only by `uploaded()` or `forceFresh`, which only `isRedeemedConflict` triggers.

**Issue:**

- The resume key is `(network, gate, address)`. The stored value is any string.
- A digest that is not a successful consume of this gate by this address is reused for every future
  upload. The gateway rejects it with a non-409 error, which never triggers `forceFresh`, so gated
  uploads for that gate and address fail until site data is cleared. Ways such a digest can arrive:
  - a failed on-chain consume returned by an executor that does not throw on failure (the port type
    allows `{ digest?: string }`);
  - a tampered or corrupted entry;
  - a digest from a consume of a pass later found invalid.
- The digest is also not tied to the `nftId` used.
- The pending-certify store, by contrast, is validated field by field (`flow.ts:176-214`).

**Impact:** a stuck user with no in-app recovery. Funds are not at risk.

**Original remediation (first pass):**

- Store `{ digest, nftId, savedAt }`.
- Validate the digest format (base58, 32 bytes).
- Before reuse, optionally confirm on-chain that it is a successful `AccessConsumedEvent` of this gate
  with `consumer == address`. Drop it otherwise.
- Treat the gateway's "consume invalid" class of response like a redeemed conflict: consume anew,
  bounded.
- Add tests.

**Remediation / evidence (2026-10-09):** RESOLVED in 0.0.26 (`d1bb9cc`). `readStoredConsume` (`src/flow.ts`) reads `{ digest, nftId, savedAt }` and reuses it only if it is under 4 KiB, a valid transaction digest (`isTransactionDigest` from nft-gate-client), for the same `nftId`, not older than `CONSUME_RESUME_MAX_AGE_MS` (4 days; the gateways refuse a consume older than 5) and not more than 60 s in the future. Anything else is removed and a new consume is spent. A consume result without a valid digest is refused instead of stored. A resumed consume the gateway rejects (403 "single-use consume") is dropped and consumed anew once (`isConsumeRejected`), which is the recovery path the finding asked for.

Tests (`tests/flow.test.ts`): "drops a stored value that is malformed, for another pass, stale, or from the future, and consumes anew"; "refuses a consume result without a valid digest instead of storing it"; "a rejected RESUMED consume is dropped and consumed anew, once"; "consumes a use bound to the challenge nonce and persists {digest, nftId, savedAt} before signing".

Not adopted: the optional on-chain confirmation of the stored digest before reuse. The gateway is the verifier, and its 403 triggers the bounded re-consume, so the extra read adds a liveness dependency without closing a gap.

### F9 — The committed dependency tree violates `@mysten/walrus`'s peer range, masked by `legacy-peer-deps`

**Severity:** Low   **Disposition:** RESOLVED (0.0.26, `d1bb9cc`)
**Where:** `package-lock.json` (`@mysten/sui` 2.33.1); `package.json` (`"@mysten/sui": "^2.33.1"`,
`"@mysten/walrus": "~1.2.32"` as dependencies); `.npmrc` (`legacy-peer-deps=true`).

**Issue:**

- `@mysten/walrus` 1.2.32 declares the peer `@mysten/sui ^2.33.2`. The lockfile installs 2.33.1.
- `npm ls` fails with `ELSPROBLEMS … invalid: "^2.33.2" from node_modules/@mysten/walrus`.
- `legacy-peer-deps=true` hides this at install time.
- Its comment ("Safe here: walrus-client has no peer deps of its own that this could mask") is wrong:
  it masks the peers of dependencies.
- So the unit tests, and any consumer that inherits this resolution, run an SDK pair that upstream
  declares incompatible.
- Both SDKs are **dependencies**, not peers. This is the same structural concern as
  `access-gate-client-audit.md` F9: hosts dedupe today only because the dashboard pins 2.33.2.

**Impact:**

- Undetected SDK incompatibility in CI.
- Possible duplicate `@mysten/sui` / `@mysten/walrus` copies in hosts, which means duplicate wasm and
  `#private`-mismatch type errors (dashboard `CLAUDE.md`).

**Original remediation (first pass):**

1. Raise the floor to `^2.33.2` and regenerate the lockfile.
2. Remove `legacy-peer-deps`, resolving the vitest/vite peer by pinning compatible versions.
3. Make `@mysten/sui` (and possibly `@mysten/walrus`) peer dependencies, plus devDependencies.
4. Add `npm ls --all >/dev/null` to Node CI.
5. Record this in the ADR-0001 shared-dependency matrix.

**Remediation / evidence (2026-10-09):** RESOLVED in 0.0.26 (`d1bb9cc`): `@mysten/sui` (`^2.33.2`) and `@mysten/walrus` (`~1.2.32`) are `peerDependencies` and also devDependencies (`^2.35.0`, `~1.2.32`); `.npmrc` is deleted, so `legacy-peer-deps` no longer hides anything; `npm ls --all >/dev/null` runs in `node-ci.yml` and in the `verify` job of `npm-publish.yml`. Checked 2026-10-09: `npm ls --all` exits 0 (installed sui 2.35.0, walrus 1.2.34, nft-gate-client 0.0.16) and `npm audit --audit-level=high` reports 0. The lockfile no longer pins the invalid pair.

ADR-0001's baseline text still reads `@mysten/sui ^2.33.1` and walrus 1.2.31; this package's floor (`^2.33.2`) is above it for the reason `@mysten/walrus` requires, so there is no deviation to flag; the ADR text itself is outside this audit.

### F10 — Epochs and the tip cap are passed through unvalidated; `max_epochs_ahead` is hardcoded

**Severity:** Low   **Disposition:** RESOLVED (0.0.26, `d1bb9cc`)
**Where:**

- `src/flow.ts:364, :431` (`epochs` straight to register);
- `src/upload.ts:62, :123` (default 53, but a caller value is not clamped);
- `src/upload.ts:14` (`MAX_SINGLE_RESERVATION_EPOCHS = 53`);
- `src/client.ts:100, :125, :155` (`uploadRelayMaxTipMist: number`).

**Issue:**

- **Epochs.** A caller value of 0, negative, fractional or above 53 reaches the register transaction.
  Values above `max_epochs_ahead` abort on-chain (`reserve_space` code 2), but only after a wallet
  prompt and gas.
- **Hardcoded maximum.** The maximum is a constant, not read from the Walrus system object. If the
  network changes `max_epochs_ahead`, the client either rejects valid values or proposes invalid ones.
- **Tip cap.** The cap is a JavaScript `number` with no validation. NaN, a negative or an unsafe
  integer reach `sendTip.max`, where SDK behaviour is unspecified. TS-M3 calls for `bigint` amounts.

**Impact:** failed, paid transactions and confusing errors (epochs); an unclear safety bound if a
caller mis-sets the cap.

**Original remediation (first pass):**

- Validate `epochs` as an integer in `[1, max_epochs_ahead]`, reading the live value through the SDK
  (system state) with 53 as the fallback.
- Validate the tip cap as a positive safe integer, or accept `bigint`.
- Add tests.

**Remediation / evidence (2026-10-09):** RESOLVED in 0.0.26 (`d1bb9cc`), `src/limits.ts`: `assertEpochs(epochs, max)` requires a safe integer in `[1, max]`; paths with a client read the live `max_epochs_ahead` through `maxEpochsAhead(client)` (`src/upload.ts`) and fall back to `MAX_SINGLE_RESERVATION_EPOCHS = 53`; `runBlobUpload` calls `assertEpochs` before any wallet prompt or gas. `createWalrusClient` calls `assertTipCapMist` (positive safe integer) on `uploadRelayMaxTipMist`.

Tests: `tests/upload.test.ts` "rejects 0, negatives, fractions, NaN and values above the live maximum" and "falls back to 53 when the system state cannot be read"; `tests/flow.test.ts` "rejects invalid epochs before any wallet prompt"; `tests/client.test.ts` "rejects NaN, zero, negatives, fractions and unsafe integers".

Residual, ADJUDICATED: the tip cap stays a JavaScript `number` (TS-M3 asks for `bigint`). It is validated as a safe integer and its default is 5e7 MIST, far below 2^53, so no precision is lost; switching the public option type would be a breaking change with no safety gain.

### F11 — `./http`: aggregator bytes are trusted, `alreadyCertified` details are discarded, bodies are unbounded, redirects are followed

**Severity:** Low   **Disposition:** RESOLVED (0.0.26, `d1bb9cc`); aggregator trust ACCEPTED-RISK, documented
**Where:** `src/http.ts:46-66` (`storeBlobViaPublisher`) and `:87-117` (`readBlob`).

**Issue:**

- **`readBlob` trusts the aggregator.** `strict_consistency_check=true` asks the aggregator to check
  the encoding before serving, but the client cannot tell whether it did. No blob id is re-derived
  locally, so a hostile or compromised aggregator can return arbitrary bytes for a blob id. For Seal
  ciphertext (seal-ui) this is caught downstream by AEAD and header checks; for any other use it is
  not. WAL-M6.
- **`storeBlobViaPublisher` drops the `alreadyCertified` details.** It returns only the blob id.
  - When the publisher answers `alreadyCertified`, **no Blob object is sent to `sendObjectTo`**, so the
    user owns nothing they can extend.
  - The existing blob's `endEpoch` (possibly shorter than `opts.epochs`) is discarded.
  - Callers cannot tell either fact.
- **Unbounded bodies.** Error bodies (`res.text()`) and success bodies (`res.json()`) are read
  unbounded.
- **Redirects.** Both functions follow redirects (fetch's default), so the https check applies to the
  configured origin only.

**Impact:**

- Content integrity for non-encrypted reads.
- Silent loss of ownership and lifetime control for publisher-stored blobs.
- Memory spikes from hostile endpoints.

**Original remediation (first pass):**

- Return `{ blobId, kind: 'newlyCreated' | 'alreadyCertified', endEpoch, blobObjectId? }` from
  `storeBlobViaPublisher`.
- Document the trust in the aggregator. Optionally offer a verified read through the full SDK for
  high-value plaintext (outside `./http`, which must stay `@mysten`-free).
- Bound response bodies.
- Pass `redirect: 'error'`.
- Add tests.

**Remediation / evidence (2026-10-09):** RESOLVED in 0.0.26 (`d1bb9cc`), `src/http.ts`:

- `storeBlobViaPublisher` returns `{ blobId, kind: 'newlyCreated' | 'alreadyCertified', endEpoch?, blobObjectId? }` (`PublishResult`); the doc comment states that `alreadyCertified` creates no Blob for `sendObjectTo` and that the blob lives only until `endEpoch`.
- Publisher responses (success and error) are read through `readTextCapped` with `MAX_PUBLISHER_RESPONSE_BYTES = 64 KiB`; `readBlob` keeps its streamed cap.
- Both functions pass `redirect: 'error'`.
- `readBlob`'s doc comment and `SECURITY.md` state that the aggregator is trusted for the bytes it returns (no local blob-id re-derivation). That part is the decision on OQ4: document, and verify through the full SDK or a hash recorded elsewhere when plaintext matters. Sealed content is protected downstream by authenticated encryption. It remains WAL-M6 "partial" by design.

Tests (`tests/http.test.ts`): "reports the details a caller needs: object id and end epoch, and that an already-certified blob created no object"; "refuses redirects and bounds the response"; "refuses a blob over maxBytes, by declared length or by bytes read".

### F12 — `SECURITY.md` misstates the tip invariant and omits the Walrus data properties

**Severity:** Low   **Disposition:** RESOLVED (0.0.26, `d1bb9cc`)
**Where:** `SECURITY.md:25-27`.

**Issue:**

- Invariant 2 says the default tip cap is `1,000,000` MIST and is "checked in BigInt math before the
  tip transfer is added". In fact:
  - the default is `50_000_000` (`client.ts:176`, changed earlier per CLAUDE.md);
  - the check is performed by `@mysten/walrus` (`sendTip.max`), not by this package.
- The policy says nothing about:
  - blob ownership per path (WAL-M5);
  - permanence by default (WAL-M4);
  - all stored data being public, with the relay seeing plaintext (WAL-M7);
  - the publisher `alreadyCertified` case (F11).

**Impact:** a published security policy that asserts a property the package does not implement, at a
value it does not use.

**Original remediation (first pass):**

- Correct invariant 2: the SDK enforces the cap, the default is 0.05 SUI, and it is re-verified on
  every `@mysten/walrus` upgrade.
- Add a "Data properties" section: public by default; the relay sees plaintext; permanent; who owns
  the Blob on each path.

**Remediation / evidence (2026-10-09):** RESOLVED in 0.0.26 (`d1bb9cc`). `SECURITY.md` invariant 2 now says the SDK enforces the cap, the default is 50,000,000 MIST (0.05 SUI), the value is validated as a positive safe integer, and it is re-verified on every `@mysten/walrus` upgrade. A new "Data properties" section states: everything on Walrus is public unless encrypted first and the relay and publisher see plaintext; storage is time-limited and blobs are registered permanent by default; ownership per path (wallet upload owns the Blob; publisher upload sends it to `sendObjectTo` except for `alreadyCertified`); and `readBlob` trusts the aggregator. A note marks `uploadRelayHost` as a trust boundary. `SECURITY.md` is still not in `files` (F18).

### F13 — Test gaps: management and raw-upload paths, SDK honouring of the auth hook, an ungated tip-less localnet relay

**Severity:** Low   **Disposition:** MITIGATED (0.0.26, `d1bb9cc`; localnet relay still ungated and tip-free)
**Where:**

- coverage: `manage.ts` 45.83%, `upload.ts` 73.33%;
- `tests/client.test.ts` (mocks `@mysten/walrus`);
- `localnet/config/relay.yaml` (`tip_config: !no_tip`, `tx_freshness_threshold_secs: 36000`);
- `localnet/relay.compose.yml` (no gateway).

**Issue:**

- **Untested code paths:**
  - `setBlobAttributes`'s first-write fallback and `isMissingFieldError` (`manage.ts:15-18, 161-169`);
  - `readBlobAttributes` returning null (`:206-207`);
  - `uploadImageBytes` and `createBlobUploadFlow` (`upload.ts:120-143`).
- **The auth hook is proven only against a mock.** The relay-auth tests mock `@mysten/walrus` and
  assert the options passed to it. That `UploadRelayClient` actually calls the supplied `fetch` — the
  property CLAUDE.md says to re-verify on every SDK upgrade — is not proven in this repo. It was
  proven live elsewhere: token-deployer-ui `e2e:walrus` through the operator relay, 2026-10-01.
- **The localnet relay is too permissive.** It runs with no tip, a 10-hour freshness window and no
  gateway. The nightly integration suite therefore never exercises:
  - tip enforcement;
  - the gated proof path;
  - the freshness window that F7's remediation depends on.

**Original remediation (first pass):**

1. Add a hermetic test that constructs the real `@mysten/walrus` client with an injected `fetch` and
   observes the Authorization header on the relay request, so an SDK upgrade that drops `fetch` fails
   CI.
2. Run the localnet relay with a linear tip and the production freshness window. Optionally put the
   nft-gate `gateway-rust` container in front, for a gated localnet case.
3. Cover the `manage.ts` and `upload.ts` gaps.

**Remediation / evidence (2026-10-09):** Items 1 and 3 are done in 0.0.26 (`d1bb9cc`):

- **SDK honours the hook:** `tests/relay-auth-sdk.test.ts` builds the real `@mysten/walrus` client, stubs the global `fetch`, and asserts `Authorization: Bearer tok-1` on the relay request and none on any other origin. An SDK upgrade that drops `fetch` now fails CI.
- **Coverage gaps:** `tests/manage.test.ts` covers the first-write fallback and the missing-attribute null ("setBlobAttributes retries the first write with the blob object when the field does not exist yet", "readBlobAttributes returns null for a blob without a metadata field and rethrows other errors"); `tests/upload.test.ts` covers `uploadImageBytes` and `createBlobUploadFlow`. Coverage was not re-measured (plugin not installed); unit tests went 81 to 105.

Item 2 is not done: `localnet/config/relay.yaml` is still `tip_config: !no_tip` with `tx_freshness_threshold_secs: 36000`, and `relay.compose.yml` has no gateway (both unchanged since 2026-09-30). Compensating evidence: the tipped, gated operator-relay path was exercised live on 2026-10-09 (paywall e2e through the Worker, `nft-gate:access:v2` proof, upload) and by token-deployer-ui `e2e:walrus`. The nightly localnet suite therefore still does not cover tip enforcement or the gated path, which stays recorded in C.2.

### F14 — `relayAuthFetch` and client-construction edge cases

**Severity:** Info   **Disposition:** ACCEPTED-RISK (Info; revisit at the pre-mainnet gate)
**Where:** `src/client.ts:117-169, :187-207`.

- **Request headers dropped.** With a `Request` object and no `init`, the Request's own headers are
  replaced: `new Headers(init?.headers)` is empty, so the request goes out with only Authorization.
  The SDK passes URL strings today.
- **No redirect policy.** There is no `redirect: 'error'`. Spec-compliant clients strip Authorization
  on cross-origin redirects; confirm for Node's undici and pin the behaviour.
- **http relay without a token.** `uploadRelayHost` is not https-validated when no token is supplied,
  so a non-loopback http relay receives the plaintext blob and the tip transaction in the clear.
- **http storage nodes.** `storageNodeUrlScheme: 'http'` is accepted on testnet and mainnet, not just
  localnet.

**Original remediation (first pass):**

- Merge the Request's headers.
- Set `redirect: 'error'` for relay calls.
- Require https for any non-loopback relay host.
- Allow `http` storage nodes only when `network === 'localnet'`.

**Remediation / evidence (2026-10-09):** Re-read 2026-10-09: `relayAuthFetch` and `createWalrusClient` are unchanged by 0.0.26/0.0.27, so all four sub-items stand. Accepted for testnet because none is reachable from the shipped apps: the SDK calls the hook with URL strings (shown by `tests/relay-auth-sdk.test.ts`), so the `Request`-headers case does not occur; relay and storage hosts are operator-set (`VITE_WALRUS_RELAY_*`, https); and the token path itself refuses non-https, non-loopback relays. Still worth doing before mainnet because each is a one-line change (merge `Request` headers, `redirect: 'error'` for relay calls, require https for any non-loopback relay host, allow `http` storage nodes only on localnet); see the pre-mainnet gate in Section D.

### F15 — Attribute errors are classified by message text

**Severity:** Info   **Disposition:** ACCEPTED-RISK (Info)
**Where:** `src/manage.ts:14-19`, `:197-208`.

**Issue:** `isMissingFieldError` also matches any message containing "does not exist". So:

- `readBlobAttributes` reports "no attributes" (`null`) for a wrong or non-existent `blobObjectId`;
- `setBlobAttributes` retries through the fallback path for it.

**Original remediation (first pass):** classify by error `code` only; when falling back, first confirm that the
Blob object exists; add tests.

**Remediation / evidence (2026-10-09):** Re-read 2026-10-09: `isMissingFieldError` in `src/manage.ts` is unchanged (it still matches the messages "does not exist" and "Dynamic field not found" in addition to the error `code`). Accepted: a wrong `blobObjectId` makes `readBlobAttributes` return `null` and makes `setBlobAttributes` take the fallback path, whose transaction then fails on-chain with a clear error and no funds at risk beyond the failed attempt. The 0.0.26 tests (`tests/manage.test.ts`) pin both the `code` and message forms, so a tightening would be a deliberate change.

### F16 — `fetchOwnedWalrusBlobs` omits `deletable`

**Severity:** Info   **Disposition:** ACCEPTED-RISK (Info)
**Where:** `src/query.ts:40-51, :105-112`.

**Issue / Impact:** UIs cannot show whether a blob can be deleted by its owner, which is the
permanence property the WALRUS lens asks projects to make visible. The registered epoch is also
omitted.

**Original remediation (first pass):** add `deletable: boolean`, parsed strictly like the other fields, and
optionally `startEpoch`.

**Remediation / evidence (2026-10-09):** Re-read 2026-10-09: `OwnedBlob` (`src/query.ts`) has `objectId`, `blobId`, `size`, `endEpoch` and `certified`; still no `deletable` or start epoch. Accepted: the package registers every blob permanent by default (stated in README, CLAUDE.md and now `SECURITY.md` Data properties), and the apps that offer deletable uploads keep the choice they made in their own pending-certify store. Adding `deletable: boolean` (parsed strictly) remains a small, non-breaking enhancement for the pre-mainnet gate.

### F17 — Localnet harness and integration CI pinning; committed deployer key

**Severity:** Info   **Disposition:** MITIGATED (partly fixed 2026-10-09); committed key ACCEPTED-RISK, documented
**Where:** `.github/workflows/integration.yml`, `localnet/scripts/lib.sh`, `localnet/relay.compose.yml`,
`localnet/README.md`.

- **Unpinned or mutable references:**
  - the Sui CLI is `testnet-v1.80.0`, while the Move packages publish with 1.81.0;
  - the workflow uses `npm install`, not `npm ci`;
  - `access-gate-sui` is checked out at `vars.ACCESS_GATE_REF || 'main'`;
  - the upstream `MystenLabs/walrus` checkout is pinned by tag, not SHA;
  - images use mutable tags (`walrus-service:testnet-v1.56.0`, `walrus-upload-relay:testnet`).
- **Privilege escalation.** The harness falls back to `sudo -E docker`, and `down.sh --clean` may run
  `sudo rm -rf` on the upstream checkout.
- **Doc drift.** `localnet/README.md` says the default ref is `testnet-v1.53.0`; `lib.sh` uses
  `testnet-v1.56.0`; `up.sh`'s error message suggests `testnet-v1.55.2`.
- **Committed key.** The deployer private key is committed deliberately (`lib.sh:71-82`, README). It is
  documented as public and localnet-only — never fund it elsewhere. Accepted.

**Original remediation (first pass):**

- Pin the checkout by SHA and the images by digest.
- Use `npm ci`.
- Align the Sui CLI with 1.81.0.
- Pin `access-gate-sui` to the commit that the access-gate-client deployment records.
- Correct the README.

**Remediation / evidence (2026-10-09):** Fixed in `b3e4715` (2026-10-09): `integration.yml` installs sui `testnet-v1.81.0` (matches the Move repos' `Published.toml`) through `suiup` v0.0.14 whose archive and the resulting `sui` binary are both sha256-checked; the `ACCESS_GATE_REF` checkout and the upstream Walrus checkout are unchanged. Dependabot (`5175f2c`) now updates the pinned actions weekly.

Still open, and accepted for an ephemeral localnet-only harness that holds no real keys or funds: `integration.yml` uses `npm install` (not `npm ci`); `access-gate-sui` is checked out at `vars.ACCESS_GATE_REF || 'main'`; the upstream `MystenLabs/walrus` checkout is pinned by tag (`testnet-v1.56.0`), not SHA; images use mutable tags (`walrus-upload-relay:testnet`, `walrus-service:testnet-*`); the harness still falls back to `sudo -E docker` and `down.sh --clean` may `sudo rm -rf` the upstream checkout; and the docs drift persists (`localnet/README.md` says default ref `testnet-v1.53.0` in one place and `v1.55.2` in another, `lib.sh` uses `v1.56.0`, `relay.compose.yml` defaults the aggregator image to `v1.55.2`). The committed deployer key (`lib.sh`) remains documented as public and localnet-only.

### F18 — Packaging, CI and documentation drift

**Severity:** Info   **Disposition:** DEFERRED (pre-mainnet packaging gate in Section D; the `.d.ts` question is a maintainer decision, OQ3)

- **Declarations:** no `.d.ts` and no `types` condition (as in seal-client; unlike the declaration-only
  siblings).
- **`SECURITY.md`** is not in `files`.
- **Publish verification** uses `--if-present` and has no lint step.
- **No `engines`** field.
- **`@mysten/walrus`** is pinned `~1.2.32`; 1.2.33 is available. The tilde blocks patch releases
  across minors only, so it is adequate.
- **`AGENTS.md` is stale.** It says "Version `0.0.1`", lists the layout as `packages/walrus-client/`,
  and omits `flow.ts`, `http.ts` and `node.ts`.
- **Shellcheck** runs in Node CI (positive). The unit suite and the localnet suite are separate.

**Original remediation (first pass):** add `SECURITY.md` to `files`; drop `--if-present`; add lint to the
publish verification; refresh `AGENTS.md`; decide on declarations (OQ3).

**Remediation / evidence (2026-10-09):** Re-read 2026-10-09 against 0.0.27. Fixed on the way: `npm ls --all` now runs in the publish `verify` job (`d1bb9cc`); weekly grouped Dependabot (`5175f2c`); Node 24 in all workflows; the npm client for trusted publishing is pinned (`npm@11.20.0`). Still true: no `.d.ts` and no `types` condition (TS-M9 asks for declarations where sibling SDKs ship them, so this is also a lens item); `SECURITY.md` was corrected (F12) but is still not in `files` (`npm pack` lists 14 files without it); the publish `verify` job still uses `--if-present` and has no lint step; no `engines` field; and `AGENTS.md` is still stale (Version `0.0.1`, layout `packages/walrus-client/`, no `flow.ts`, `http.ts`, `limits.ts` or `node.ts`). `@mysten/walrus` `~1.2.32` is adequate (1.2.34 installs). DEFERRED to the pre-mainnet gate (the 0.2.0 release, when the versioning policy permits shape changes); none affects behaviour or funds.

### F19 — Resume binds a fresh challenge nonce to an earlier consume

**Severity:** Info   **Disposition:** ADJUDICATED (matches the deployed gateways' digest-first
redemption); cross-ref `access-gate-sui-audit.md` F34 / OQ17
**Where:** `src/flow.ts:275-299`.

**Issue:** on resume, `createGatedAccess` signs a **new** challenge nonce but presents the consume
digest whose on-chain `AccessConsumedEvent.nonce` is the *old* challenge. This is correct for the
nft-gate gateways, which redeem by digest and do not bind the nonce. It contradicts `access_gate`'s
documented verifier contract, which requires binding the challenge nonce.

**Original remediation (first pass):** none here. Follow the OQ17 decision. If the contract wins, resume must use
a gateway endpoint that accepts the original nonce, and this module changes with it.

**Remediation / evidence (2026-10-09):** Re-read 2026-10-09: still ADJUDICATED, and now a recorded decision, not an open question. Access message v2 is audience-bound and digest-first: `token()` signs `nft-gate:access:v2` over the relay origin, gate, network, the current challenge nonce and the consume digest (`tests/flow.test.ts` "signs the audience-bound message…"), and the gateways redeem by digest. The first consume is still built with the challenge nonce of that moment (`buildConsume(nftId, nonce)`); a resumed token signs a newer nonce. The sibling record is `access-gate-sui-audit.md` F34 / OQ17, whose status is that audit's to update.

### F20 — Positive: relay-auth wiring

**Severity:** Positive

- The token is threaded through the SDK's supported `fetch` hook, not the silently dropped `headers`
  option (asserted: `uploadRelay.headers` is undefined).
- Origin-scoped (`target.origin === relayOrigin`); resolved per request through a provider; refused
  over non-loopback http.
- `globalThis.fetch` is never patched.
- The token never reaches RPC, storage nodes or aggregators (they use other fetches).
- `createRelayAccessToken` and the flow use nft-gate-client's challenge fetch, which has a 10 s
  timeout, an https requirement and a validated response; since 0.0.26 the signed message is the
  audience-bound `nft-gate:access:v2` (relay origin, gate, network, nonce, consume digest).
- A hermetic test now proves the real SDK calls the hook (`tests/relay-auth-sdk.test.ts`, F13).

### F21 — Positive: upload-flow invariants

**Severity:** Positive

- **Register and permanence.** A fresh register on every attempt (asserted). Permanent by default,
  deletable on request (asserted). `owner` and sender are the connected address on both register and
  certify (asserted).
- **Consume record.** `{ digest, nftId, savedAt }` is persisted before register and reused without a new
  consume only when valid for this pass and recent (asserted). Cleared once the upload lands, even if
  certify fails (asserted). A fresh consume happens only on `409 redeemed` (bounded cause-chain search)
  or one rejected resumed consume (asserted) — never on other failures (asserted).
- **Token timing and retries.** The token is minted after register, before each upload attempt; a failed
  upload is retried on the same registration, bounded (F7, asserted).
- **Certify.** A certify failure carries a retry that never re-uploads (asserted).
- **Existing copies.** The precheck runs before register, with `force` to bypass (asserted).
- **Persisted state.** Pending certificates are validated per entry, keyed by `blobObjectId`, and
  capped at 1 MB (asserted). `browserStorage()` never throws (asserted).
- **Lazy loading.** `./flow` loads the package root dynamically, keeping wasm out of the eager bundle.

### F22 — Positive: queries, `./http` hygiene, release chain

**Severity:** Positive

- **`fetchOwnedWalrusBlobs`:** resolves the Blob type dynamically from the SDK (no hardcoded
  addresses); pages with a bound and throws past 100 pages; re-checks the exact normalised type;
  skips malformed entries rather than inventing values (all asserted); accepts a real u256 blob id and
  nothing above `u256::MAX` (F23, asserted).
- **`./http`:**
  - https-only, with timeouts (120 s store, 60 s read);
  - `permanent=true` and a required `send_object_to`;
  - blob-id format validated;
  - a streamed read cap that does not trust `Content-Length`, a 64 KiB cap on publisher responses,
    and refused redirects (asserted).
- **No hardcoded Walrus package IDs.** localnet configuration is caller-supplied.
- **Release chain:** SHA-pinned actions; least privilege; OIDC `--provenance` (verified for 0.0.27 on the registry, 2026-10-09);
  tag == version; idempotent publish; shellcheck in CI; `npm audit` gates.

### F23 — `fetchOwnedWalrusBlobs` listed no blobs on a live network in 0.0.23–0.0.26

**Severity:** Medium   **Disposition:** RESOLVED (0.0.27, `83521fc`)
**Where:** `src/query.ts` (`uintField`, `fetchOwnedWalrusBlobs`); introduced by the strict-parsing change in 0.0.23 (`3c96e9c`).

**Issue:** 0.0.23 made owned-blob parsing strict and capped every integer field at u64's 20 digits. A
blob id is a `u256` (up to 78 decimal digits), so every real blob failed the check and was skipped; the
function returned an empty list on a live network. The unit tests used one-digit ids, so they stayed
green. The first-pass audit (2026-10-03) read this code as correct (F22 "skips malformed entries") and
missed it, because its own run could not execute the localnet suite.

**Impact:** every consumer that lists a wallet's blobs (walrus-ui `useOwnedBlobs` / `WalrusView.vue`,
token-deployer-ui `WalrusBlobBrowser.vue`) saw an empty list from 2026-10-02 until the fix, so the
extend and existing-copy flows built on those listings had nothing to act on. No funds were at risk
(read-only), and 0.0.23–0.0.26 shipped with it.

**Remediation / evidence:** RESOLVED in 0.0.27 (`83521fc`, CHANGELOG 2026-10-09). `uintField(v, maxDigits)`
takes a per-field limit: 20 for `size` and `end_epoch`, 78 for `blob_id`, and the parsed id must not exceed
`MAX_U256 = 2^256 - 1`. Pinned by `tests/query.test.ts` "lists a blob whose id is a real u256 (up to 78
digits), not only small test ids" (a 77-digit id and `u256::MAX` are listed; `u256::MAX` with an extra digit
and a 79-digit id are skipped). The regression was caught by the nightly localnet suite
(`lifecycle.integration.test.ts` "lists the certified blob among the address's owned blobs"), red from
2026-10-02 and PASSING again on 2026-10-09. See F24 for the process gap that let 0.0.26 ship while it was red.

### F24 — The nightly localnet suite is neither alerted on nor a release gate

**Severity:** Low   **Disposition:** ACCEPTED-RISK (maintainer decision, OQ5)
**Where:** `.github/workflows/integration.yml` (`schedule` + `workflow_dispatch` only); `.github/workflows/npm-publish.yml` (`verify` runs unit checks only).

**Issue:** the localnet suite is the only test that runs the real Walrus lifecycle, and it is the only
thing that caught F23. It was red from 2026-10-02, yet 0.0.26 was tagged and published on 2026-10-08
because neither the publish workflow nor any alert depends on it. The suite is slow (45-minute budget,
Docker) and deliberately kept off the PR path.

**Impact:** a defect only the integration suite can see can reach npm, as F23 did. The cost was a window of empty
owned-blob listings from 2026-10-02 to the 0.0.27 release; the suite did catch it, so detection worked
and delivery did not.

**Remediation / evidence:** accepted for now: the suite is heavy, and the packages are pre-v0.2, where
patch releases are cheap. Options for the maintainer (OQ5):
check the last nightly run before tagging (a manual step), notify on a failed scheduled run, or run the
suite in the `verify` job. Tracked as a pre-mainnet item in Section D (maintainer-only; no
`OPERATOR_TASKS.md` row yet).

---

## Section A — Invariant verification matrix

| # | Invariant | Enforced / asserted at | Proven by | Status |
| --- | --- | --- | --- | --- |
| I1 | **Payment bounds:** relay tip capped client-side | `sendTip.max` (SDK); `assertTipCapMist` | `defaults the tip ceiling to 0.05 SUI` (option only); `rejects NaN, zero, negatives, fractions and unsafe integers` | HOLDS (SDK-enforced; input validated — F10) |
| I2 | **Relay authentication:** token only to the relay origin, per request, via an honoured mechanism, never over plain http, never logged | `relayAuthFetch` | F2/F4/F6 tests | HOLDS (SDK honouring proven by `relay-auth-sdk.test.ts` — F13; edge cases accepted — F14) |
| I3 | **Relay selection** cannot bypass gating or commission | apps choose the host; gating is at the gateway | — | N/A here (enforced server-side; client-side choice stated in the walrus-relay audit) |
| I4 | **Epochs ≤ `max_epochs_ahead`; deletable default stated** | defaults 53 / permanent | upload/flow tests | HOLDS — `assertEpochs` against the live maximum (53 fallback); permanent default (F10) |
| I5 | **Blob ownership** stated per path | relay path: `owner = address`; publisher: `send_object_to` | flow and http tests | HOLDS — `alreadyCertified` yields no owned Blob and `PublishResult.kind` says so (F11); documented in `SECURITY.md` (F12) |
| I6 | **Read integrity** | `strict_consistency_check` (aggregator-side) | http test (parameter) | Partial — aggregator trusted for bytes, documented (F11, ACCEPTED-RISK) |
| I7 | **Data public unless encrypted** | `SECURITY.md` Data properties | review | HOLDS — stated (F12) |
| I8 | **Flow resumability:** no double payment, no lost use | consume record persisted and validated; same-registration upload retry (50 min, 3 attempts); certify retry | flow tests (F7, F8) | HOLDS — within a live session; a reload after register but before upload orphans one registration (ACCEPTED-RISK, F7) |
| I9 | **Size limits** are UX only, enforced at the edge | `readBlob` cap; `maxBytes` on store; 64 KiB publisher-response cap | http tests | HOLDS (authoritative limit is the gateway's — WORKERS lens) |
| I10 | **Pagination** of owned blobs | `fetchOwnedWalrusBlobs` | paging and bound tests | HOLDS |
| I11 | **Lazy loading** of wasm | `./flow` dynamic import | code; CLAUDE.md invariant | HOLDS (code-only) |
| I12 | **Network configuration** from the SDK or the caller, never ad hoc | `getWalrusPackageConfig`, `walrusPackageConfig` | localnet tests | HOLDS |
| I13 | **Exact types; no invented values** in reads, and real values accepted | `query.ts` | query tests, incl. the u256 blob id (F23) and the nightly localnet listing | HOLDS (regression 0.0.23–0.0.26 fixed in 0.0.27, F23) |
| I14 | **Dependency tree satisfies declared peers** | `peerDependencies`, lockfile | `npm ls --all` in CI and publish | HOLDS (F9) |
| I15 | **Execution outcome and finality** (SUI_CLIENT) | register and certify go through the injected executor and `waitForTransaction`; the consume wait is best-effort by design | flow tests; the executor's effects check is wallet-adapter's | HOLDS here (status checking is the executor's — wallet-adapter audit) |

---

## Section B — Supply-chain, publish-authority & capability matrix

### B.1 Dependency & CVE risk

`npm audit --audit-level=high`: **0 vulnerabilities** (2026-10-09, also 2026-10-03). `npm ls --all`:
exit 0 (2026-10-09; the 2026-10-03 invalid peer is fixed, F9).

| Dependency | Pinned (installed) | Liveness dependency? | CVE / audit status | Notes |
| --- | --- | --- | --- | --- |
| `@mysten/walrus` | peer and dev `~1.2.32` (1.2.34) | every Walrus operation | clean | relay-auth wiring is re-verified on every upgrade by `relay-auth-sdk.test.ts` (F13) |
| `@mysten/walrus-wasm` | transitive (0.3.1) | encoding | clean | lazy-loaded through `./flow` |
| `@mysten/sui` | peer `^2.33.2`, dev `^2.35.0` (2.35.0) | gRPC client, transactions | clean | satisfies walrus's peer; a peer, so hosts own the single copy (F9) |
| `@meddleware/nft-gate-client` | `^0.0.16` (0.0.16) | challenge / proof | provenance attested | wire protocol (`nft-gate:access:v2`) shared with both gateways |
| Upload relay (operator / public) | caller / defaults | uploads — **fails closed** | n/a | tip via SDK cap |
| Aggregator | defaults / caller | reads — fails closed (no bytes) | n/a | trusted for content, documented (F11) |
| HTTP publisher | caller | `./http` stores — fails closed | n/a | publisher pays; user owns via `send_object_to` |
| Storage nodes | Walrus committee | certification | n/a | SDK |

**TS lens shared-dependency matrix row (this repo):**

| Package | dependency | devDependency | peer |
| --- | --- | --- | --- |
| `@mysten/sui` | — | `^2.35.0` | `^2.33.2` |
| `@mysten/walrus` | — | `~1.2.32` | `~1.2.32` |
| `@meddleware/nft-gate-client` | `^0.0.16` | — | — |
| `typescript` / `vitest` / `vite` | — | `^6.0.0` / `~5.0.2` / `^8.1.5` | — |

No deviation from the ADR-0001 baseline (its `^2.33.1` floor is below this peer floor). The `^0.0.16`
range on the first-party dependency resolves to exactly `0.0.16`, as the versioning policy intends.

### B.WAL-1 Coupling

| Format | Producer | Consumer | Test / vector |
| --- | --- | --- | --- |
| Relay tip transaction (register PTB input 0 + tip transfer) | `@mysten/walrus` | relay | SDK-owned; localnet relay has no tip (F13); tipped path proven live 2026-10-09 |
| Access proof (`Authorization: Bearer base64(JSON{address, nonce, signature, consumeDigest?})`, signature over the `nft-gate:access:v2` message) | nft-gate-client `buildAccessProof` / `encodeAccessProof` (via `createGatedAccess` / `createRelayAccessToken`) | nft-gate gateways | nft-gate-client's published vectors (nft-gate-client audit); `flow.test.ts` asserts the exact signed message |
| Relay `409 redeemed` | gateway | `isRedeemedConflict` | flow tests (structured, message and cause forms) |
| Publisher response (`newlyCreated.blobObject.{blobId,id}` / `.resource.endEpoch` / `alreadyCertified.{blobId,endEpoch}`) | Walrus publisher | `storeBlobViaPublisher` | http tests; the fields are returned in `PublishResult` (F11) |

### B.WAL-2 Economics & operations

| Item | State |
| --- | --- |
| Tip ceiling | 0.05 SUI default (~8× the operator relay's worst case at 100 MiB); app-overridable |
| WAL funding | the user's wallet on the relay path; the publisher's on `./http` |
| Expiry monitoring / extension | `extendBlobLifetime*` and `estimateStorageCost` exist; monitoring is the apps' concern |
| Mainnet relay / aggregator / publisher | public relay and aggregator defaults exist; no publisher (none public on mainnet; seal-ui requires an operator one) |
| Orphaned registrations | not tracked; reduced to a reload between register and a landed upload (F7, ACCEPTED-RISK residual) |

### B.2 Publish authority & CI

| Authority / secret | Where | Custody | Gates |
| --- | --- | --- | --- |
| npm publish `@meddleware/walrus-client` | `npm-publish.yml` (tag `v*`) | OIDC trusted publisher; `--provenance` | releases |
| `GITHUB_TOKEN` (integration) | `integration.yml` | `contents: read` | suiup API rate limit |
| Localnet deployer key | committed (`lib.sh`) | public by design | localnet only (F17) |

#### CI & release integrity

| Item | Holds? | Evidence |
| --- | --- | --- |
| Actions pinned | Yes | SHA pins in all three workflows |
| Least privilege | Yes | `contents: read`; `id-token: write` only on `publish-npm` |
| OIDC trusted publishing | Yes | 0.0.27 attestation (registry, 2026-10-09); npm client pinned `11.20.0` |
| Tag-gated, idempotent publish | Yes | `v*`; tag == version |
| `npm ci` everywhere | No | `integration.yml` uses `npm install` (F17, accepted: localnet-only job) |
| Dependency tree check | Yes | `npm ls --all` in Node CI and the publish `verify` job (F9) |
| Dependabot | Yes | weekly grouped npm and actions updates (`5175f2c`) |
| Real funds manual-only | N/A | localnet only |
| Third-party refs pinned | Partly | suiup and the sui binary sha256-pinned (`b3e4715`); `access-gate-sui@main` and image tags remain (F17) |

### B.OPS-1 Runbook linkage

| Operation | Script | Documented in |
| --- | --- | --- |
| Bring up / bootstrap / tear down the testbed | `up.sh`, `bootstrap-localnet.sh`, `down.sh` | `localnet/README.md` (ref drift remains, F17) |
| Nightly integration | `integration.yml` | workflow comments, README |

### B.TS-1/2/3

| Check | Holds? |
| --- | --- |
| `exports` / subpath boundaries | Yes (`./flow` and `./http` honour their import rules) |
| `files` | Yes (14 files, 2026-10-09); `SECURITY.md` and `localnet/` excluded — the former should ship (F18) |
| `sideEffects: false` | Yes (no import-time effects) |
| Install-time code | none; `overrides: { nanoid: ">=3.3.18" }` (a CVE floor) |
| `npm ci` / audit gates | Node CI and publish yes; integration no (F17, accepted) |

---

## Section C — Test-coverage & hermetic/live split

### C.1 Coverage grade — B+ (105/105 unit tests; coverage last measured 2026-10-03: 90.36% statements, 85.01% branches, 93.18% lines)

Coverage was not re-measured on 2026-10-09 (the coverage plugin is not installed here). The grade rises
from B because 0.0.26 added tests for the paths the first pass listed as missing; the percentages are
historical until a maintainer re-runs `vitest --coverage`.

| Dimension | Assessment |
| --- | --- |
| Happy path | Client wiring, relay auth, flow (open and gated), persistence, query (incl. a real u256 blob id), http, extend, certify, cost, raw-blob uploads and the attribute first-write fallback (added in 0.0.26). |
| Error path | Token over http, foreign origin, 409 re-consume, same-registration retry on 5xx / network / stale challenge, retry bound, registration too old, bad stored consume, rejected resumed consume, certify failure, malformed storage and query entries, publisher and aggregator errors, redirects, oversize, invalid epochs and tip cap. **Missing:** none of the first-pass list. |
| Boundary | Read cap by header and by stream; publisher-response cap; page bound; blob-id digit limit and `u256::MAX`; epochs 0, fractions, NaN and above the live maximum. |
| Security-relevant | Strong on token scope; the real SDK honours the `fetch` hook (`relay-auth-sdk.test.ts`, hermetic). |

**Test layers:**

| Layer | Files | Gating | In CI? |
| --- | --- | --- | --- |
| Unit | 8 files, 105 tests | — | Node CI (push/PR) and publish |
| Localnet integration | `tests/integration/lifecycle.integration.test.ts`: raw upload and read, content addressing, extend, attributes, owned listing | `.env.localnet` (`WALRUS_TEST_SECRET_KEY` …) | nightly and manual (`integration.yml`); not a release gate (F24) |
| Testnet e2e (gated relay) | — (in token-deployer-ui `e2e:walrus`, walrus-ui; paywall e2e 2026-10-09) | manual | elsewhere |

### C.2 Hermetic vs. live paths

| Path | Hermetic? | Deferred to | Tracking |
| --- | --- | --- | --- |
| SDK honours the relay `fetch` hook | yes (real SDK, stubbed `fetch`) | also live: token-deployer-ui `e2e:walrus` (2026-10-01), paywall e2e (2026-10-09) | F13 |
| Relay tip enforcement | no | live only (localnet relay is tip-free) | F13 |
| Committee behaviour, certification, real blob-id shape | no | localnet lifecycle (nightly; caught F23) | F23, F24 |
| Gated proof acceptance, redemption, challenge expiry | no (the retry logic is hermetic) | testnet e2e in the apps (paywall e2e PASS 2026-10-09) | F7, F13 |
| Aggregator caching and consistency | no | live | F11 |

---

## Section D — Deployment-readiness gates

### pre-localnet

- [x] tip cap passed to the SDK; epochs default 53
- [x] relay auth attached only to the relay origin — F2/F4/F6
- [x] type-check, lint, unit tests green; `npm audit` 0; shellcheck in Node CI (not run in this sandbox on 2026-10-09)
- [x] dependency tree valid (`npm ls --all` exits 0; checked in CI and publish) — F9, `d1bb9cc`
- [x] epochs and tip cap validated before any wallet prompt — F10, `d1bb9cc`

### pre-testnet *(in use on testnet; unmet items are retroactive)*

- [x] gated-relay upload proven end to end (token-deployer-ui 2026-10-01; paywall e2e through the Worker 2026-10-09)
- [x] consume record persisted and reused by every gated-relay client (shared `createGatedAccess`)
- [x] interrupted uploads never pay twice within a live session — F7, `d1bb9cc`; a reload between register and upload is the accepted residual (register is never resumed)
- [x] stored resume state validated — F8, `d1bb9cc`
- [x] deletable default stated (README, CLAUDE.md, `SECURITY.md`) — F12
- [x] Blob ownership stated per path in `SECURITY.md` — F11, F12, `d1bb9cc`
- [x] localnet CLI aligned and checksum-pinned (sui 1.81.0, suiup) — F17, `b3e4715`
- [ ] localnet harness remaining pins (SHA for the upstream checkout, image digests, `npm ci`, `access-gate-sui` ref) — F17; maintainer-only, accepted for a localnet-only job
- [x] hermetic regression for the F23 listing bug (u256 blob ids) — `83521fc`

### pre-mainnet

- [ ] mainnet relay, aggregator and publisher choices confirmed (no public mainnet publisher) — apps; maintainer-only
- [ ] tip ceiling, WAL funding and expiry plan decided — apps (B.WAL-2); maintainer-only
- [ ] read integrity for content the apps depend on — F11 (aggregator trust documented; the apps decide whether to verify); maintainer-only
- [x] SDK-honours-`fetch` regression test in CI — `relay-auth-sdk.test.ts`, F13
- [ ] packaging refresh: `.d.ts` decision (OQ3), `SECURITY.md` in `files`, lint and no `--if-present` in publish, `engines`, `AGENTS.md` — F18; mainnet-blocked (0.2.0)
- [ ] Info hardening: `relayAuthFetch` edge cases (F14), attribute-error classification (F15), `deletable` in listings (F16) — mainnet-blocked review
- [ ] localnet suite green on the release commit, or alerted on (OQ5) — F24; maintainer-only
- [ ] external review — maintainer-only

---

## Cross-project themes

- **Supply chain & release integrity:** SHA-pinned actions; OIDC provenance (verified for 0.0.27);
  peer ranges declared and checked by `npm ls --all` in CI and publish (F9, resolved); weekly grouped
  Dependabot. The integration harness still has mutable references (F17) and is not a release gate (F24).
- **Wire-format coupling:** the access proof is shared with both nft-gate gateways (nft-gate-client
  vectors; `nft-gate:access:v2`, audience-bound), and the `409 redeemed` / `leased` / consume-403 contract
  with the Workers gateway. The tip transaction is
  SDK-owned.
- **On-chain-truth boundary:** this is a construction and orchestration layer. Tip and storage are
  paid by the user's signed transactions, and `access_gate` decides access. This package's
  responsibility is to never cause a second payment (F7, resolved) or a lost use (holds).
- **Deployment readiness:** Section D.
- **Chain-access layering (ADR-0001):**
  - Walrus objects resolve through the SDK (no IDs here); `access_gate` consume building is injected
    (`buildConsume` from access-gate-client).
  - No ABI-drift test, by design (CLAUDE.md: no direct `moveCall`).
  - The SDK version is the coupling, so peer correctness (F9, resolved) is load-bearing.
- **Pre-v0.2 policy:** patch-only bumps until go-live, breaking changes included, with no shims. F7,
  F8, F10 and F11 changed exported shapes in 0.0.26 under it; F23 shipped as 0.0.27; consumers bumped
  in step (docs still at `^0.0.26`). The F18/OQ3 packaging change waits for the 0.2.0 release.
- **Shared with sibling audits:**

  | This audit | Sibling audit |
  | --- | --- |
  | F9 | `access-gate-client-audit.md` F9 (SDK as a dependency, not a peer; this package now declares peers) |
  | F19 | `access-gate-sui-audit.md` F34 / OQ17 (nonce binding; decision recorded in F19) |
  | F18 | `seal-client-audit.md` F18 (declarations; `SECURITY.md` not shipped) |
  | F11 | `seal-client-audit.md` F6 — seal-ui stores through `./http` |
  | F23 | `walrus-ui-audit.md` and `token-deployer-ui-audit.md` (owned-blob listings consumed there) |

---

## Normative requirements (MUST / MUST NOT)

1. MUST NOT make a user pay register again for an upload whose registration is still within the
   relay's freshness window — **holds** (F7; the residual is a reload between register and upload).
2. MUST NOT reuse a persisted consume digest that is not a valid consume for this gate and address,
   and MUST offer recovery — **holds** (F8).
3. MUST resolve a dependency tree that satisfies every declared peer, checked in CI — **holds** (F9).
4. MUST validate epochs (within `max_epochs_ahead`) and the tip cap before building transactions —
   **holds** (F10).
5. MUST state in `SECURITY.md` only invariants the code implements, and MUST document ownership,
   permanence and publicity — **holds** (F12).
6. MUST list a wallet's real Walrus blobs (the u256 blob id) and never an invented value — **holds**
   since 0.0.27 (F23; did not hold in 0.0.23–0.0.26).

**WALRUS lens baseline:**

| ID | Holds? | Evidence |
| --- | --- | --- |
| WAL-M1 | cap enforced by the SDK; tip-mode parsing is the SDK's and walrus-relay's (`parseTipFromConfig`) | I1 |
| WAL-M2 | yes | I2, F20 |
| WAL-M3 | N/A here (server-side) | I3 |
| WAL-M4 | yes (validated against the live maximum; permanent default stated) | F10, F12 |
| WAL-M5 | yes (`PublishResult.kind`; `SECURITY.md` per path) | F11, F12 |
| WAL-M6 | partial (aggregator trusted for bytes, documented; ACCEPTED-RISK) | F11 |
| WAL-M7 | yes (stated in `SECURITY.md`) | F12 |
| WAL-M8 | yes within a session; reload residual accepted | F7, F8 |
| WAL-M9 | N/A (edge is the gateway's; client caps are UX) | I9 |

**SUI_CLIENT lens baseline:**

| ID | Holds? | Evidence |
| --- | --- | --- |
| SC-M1 | N/A (no IDs; SDK-resolved) | — |
| SC-M2 | yes (Blob type exact) | I13 |
| SC-M3 | register and certify awaited via `waitForTransaction`; the consume wait is deliberately best-effort and a consume result without a valid digest is refused | F21, I15 |
| SC-M4 | `size` / `endEpoch` as `number` (bounded, documented); blob id parsed as `bigint` up to `u256::MAX`; tip as a validated safe-integer `number` (ADJUDICATED) | F10, F23 |
| SC-M5 | network → RPC → relay → package config consistent | I12 |
| SC-M6 / SC-M7 / SC-M9 | N/A here (verification is the gateways') | — |
| SC-M8 | N/A | — |
| SC-M10 | yes | — |

**TS lens baseline:**

| ID | Holds? | Evidence |
| --- | --- | --- |
| TS-M1 | yes (strict; `noUncheckedIndexedAccess`) | — |
| TS-M2 | yes (stored consume, epochs, tip cap, publisher bodies validated) | F8, F10, F11 |
| TS-M3 | tip cap is a validated safe-integer `number` (ADJUDICATED, F10) | F10 |
| TS-M4 | one justified swallow (consume wait), documented | F21 |
| TS-M5 | http and challenge have timeouts; the relay and SDK timeouts are the SDK's | — |
| TS-M6 | yes (tokens never logged) | — |
| TS-M7 | yes | B.TS |
| TS-M8 | `npm ci` and audit in Node CI and publish; integration uses `npm install` (accepted, localnet-only); ADR-0001 baseline aligned | F17 |
| TS-M9 | peers declared, `legacy-peer-deps` gone; **`.d.ts` not shipped** (decision pending) | F9, F18, OQ3 |

**OPS lens baseline (localnet scope):** preflight, dedicated config, `set -euo pipefail`, shellcheck
— hold. CLI version and checksum — hold since `b3e4715` (sui 1.81.0 = `Published.toml`). Remaining
pinning — F17 (accepted). Mainnet guard and OPS-M7/M8 (no mainnet keys, manual real-chain jobs) — N/A:
the harness is localnet-only and no real-chain job exists.

## Implementation suggestions (SHOULD / MAY)

- **S1** DONE for `uploadRetry` (0.0.26, F7). A persisted `pendingUpload` entry is NOT adopted:
  register is never resumed across loads.
- **S2** DONE for epochs and tip cap (`src/limits.ts`, F10). Host validation (https for any
  non-loopback relay) is still open (F14).
- **S3** MAY add a `verifyBlobBytes(bytes, blobId)` helper in the main entry (which may use the SDK)
  for apps that read unencrypted content through `./http` (F11).
- **S4** SHOULD run a gated, tipped relay in the localnet harness (F13, still open).
- **S6** SHOULD make the nightly localnet result visible before a tag (F24, OQ5).
- **S5** MAY add `deletable` to `OwnedBlob` and a warning helper for blobs nearing expiry (F16).

## Open questions

- **OQ1** *(DECIDED 2026-10-08, 0.0.26)* F7 recovery model: (a) an in-flow same-registration retry
  with a refreshed token, bounded; (b) persisting registered-not-uploaded state was not adopted
  (register is never resumed across loads); the token is minted after register.
- **OQ2** *(DECIDED 2026-10-08, 0.0.26)* `@mysten/sui` and `@mysten/walrus` are peer dependencies (F9).
- **OQ3** *(open, maintainer; F18)* Ship `.d.ts` declarations like nft-gate-client and
  access-gate-client? TS-M9 expects it where sibling SDKs do; target the 0.2.0 release.
- **OQ4** *(DECIDED 2026-10-08, 0.0.26)* `./http` does not offer a verified read; `SECURITY.md` and the
  `readBlob` doc state the aggregator trust (F11).
- **OQ5** *(open, maintainer; F24)* Should the nightly localnet result gate a release (run in `verify`,
  or check the last run before tagging), or alert on failure?

## Risks

- **Relay sees plaintext:** anything not encrypted first (Seal) is visible to the relay operator and
  public on Walrus.
- **Aggregator trust:** reads through `./http` trust the aggregator's bytes (F11).
- **SDK coupling:** the auth-hook wiring and tip enforcement live in `@mysten/walrus`. The hook is
  now covered by a hermetic test; tip enforcement is still caught only by live tests (F13).
- **Double payment:** a reload or closed tab between register and a landed upload still orphans one
  paid, permanent registration (F7 residual). Transient failures no longer do.
- **Silent regression:** only the nightly localnet suite can catch a live-network parsing bug such as
  F23, and nothing gates a release on it (F24).
- **Harness drift:** mutable images and refs can change what the nightly suite tests (F17, accepted).

---

## Re-verification log

- 2026-10-03 — first in-repo pass at `942c36a` (tag `v0.0.25`, npm 0.0.25 with provenance).
  - **Lenses:** AUDIT_TEMPLATE.md (2026-10-02) + WALRUS (2026-09-30) + SUI_CLIENT (2026-09-30) + TS
    (2026-10-03) + OPS (2026-09-30, localnet harness only).
  - **Measured:** vitest 81/81; coverage 90.36 / 85.01 / 93.18; tsc, eslint, audit (0) and shellcheck
    clean; `npm ls` invalid peer (F9); pack 13 files.
  - **Cross-checked:** the gateway challenge TTL (300 s) and walrus-ui's existing-copy wiring.
  - **Not runnable here:** the localnet integration suite and live endpoints (no Docker testbed;
    egress blocked).
  - **IDs:** corpus IDs F2, F4 and F6 preserved from code citations. New: F7–F22; OQ1–OQ4.
  - **No findings resolved:** by maintainer instruction this pass only records findings. Remediation,
    including single-solution fixes under the resolve-inline rule, is to be applied separately, with
    each disposition moved to RESOLVED and the diff cited.

- 2026-10-09 — re-verified against `main` at `83521fc` (tag `v0.0.27`, npm 0.0.27 with provenance); the
  repo had moved from 0.0.25 through 0.0.26 (`d1bb9cc`, 2026-10-08) and 0.0.27 (`83521fc`, 2026-10-09).
  - **Lenses:** base (2026-10-08) + WALRUS (2026-09-30) + SUI_CLIENT (2026-10-08) + TS (2026-10-08) +
    OPS (2026-10-08, localnet harness only). Added the SUI_CLIENT front-matter lines (networks,
    packages consumed) and the on-chain dependency matrix; added the TS-M9 and I15 rows. AUTH and IMG
    reviewed and not triggered (reasons in the front matter).
  - **Dispositions:** RESOLVED F7, F8, F9, F10, F11 (aggregator trust ACCEPTED-RISK), F12, F23;
    MITIGATED F13, F17; ACCEPTED-RISK F14, F15, F16, F24; DEFERRED F18 (pre-mainnet 0.2.0 packaging
    gate, OQ3); ADJUDICATED F19; F2, F4, F6 re-verified RESOLVED.
  - **New:** F23 (RESOLVED) — the 0.0.23–0.0.26 owned-blob regression (u256 blob id capped at 20 digits;
    fixed in 0.0.27 with a test; caught by the nightly localnet suite, red from 2026-10-02); F24
    (ACCEPTED-RISK) — the suite is not a release gate. OQ1, OQ2 and OQ4 decided; OQ3 and OQ5 open.
  - **Register-resume:** the audit reflects that register is never resumed across loads (the tip relay
    embeds tip and nonce in the register transaction and rejects an old one as "too old"); only the
    upload is retried on the live registration (F7, S1).
  - **Measured 2026-10-09 (Node 24.13.0):** vitest 105/105 (8 files); tsc and eslint clean; audit 0;
    `npm ls --all` exit 0; pack 14 files; registry shows 0.0.27 with provenance. Not run here:
    shellcheck (not installed), coverage (plugin not installed; 2026-10-03 figures kept as historical),
    the localnet suite (no Docker; the maintainer's run PASSED 2026-10-09).
  - **Corrected stale facts:** versions (0.0.27, nft-gate-client 0.0.16, sui 2.35.0, walrus 1.2.34),
    line and file counts, peer/`.npmrc` state, sui CLI 1.81.0, consumers' ranges, Node 24.

## Pre-save consistency checklist (this pass)

- [x] Section A ↔ findings: no GAP rows remain; partial row I6 cites F11; I8 cites the F7 residual.
- [x] Finding header ↔ body: consistent; every non-Positive finding carries a disposition.
- [x] Template line: base + WALRUS + SUI_CLIENT + TS + OPS (scoped) with registry dates; untriggered
  lenses named with reasons.
- [x] Closing four-part structure present.
- [x] Section D ↔ dispositions: unticked items are mainnet-blocked or maintainer-only, each named.
- [x] Executive summary ↔ dispositions and ceiling (nothing open above Info; first-pass ceiling Medium).
- [x] C.1 counts: tests measured 2026-10-09; coverage percentages marked historical.
- [x] Re-verification log entry added (2026-10-09).
