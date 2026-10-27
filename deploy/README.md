<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Platform P0 shadow

`platform.yml` adds a portable delivery path without changing the existing CD workflow or a production resource. PRs and merge groups build and smoke-test the real console image on native amd64 and arm64 runners. Only a `dev` push publishes to GHCR, signs the merged index with GitHub OIDC, attaches GitHub SLSA provenance and an SPDX SBOM covering both native images, and publishes a signed rendered Flux artifact. The GHA v2 BuildKit cache is scoped per architecture. No QEMU, deployment credentials, private infra checkout or production environment is involved.

The public repository's push-restrictions ruleset currently blocks `deploy/**`. **The owner must update it at landing.** GHCR packages `console`, `console-unsigned`, `console-wrong-identity` (rejection fixtures) and `console-deploy` under the repository's package namespace must be publicly readable. The cluster deliberately has no registry credential; a private package fails the test rather than receiving CI's token.

## Desired state

- `base/app`: an API Deployment used as the Argo Rollout's `workloadRef` (Deployment replicas stay zero), a replica-safe worker Deployment, stable/canary Services, readiness analysis and PDBs. The canary uses replica ratios; Gateway API traffic routing remains the P1 integration gate in the ADR.
- `base/migrate`: the console's existing one-shot migration role. Rendering gives every release a digest-suffixed immutable Job name; no TTL removes a Job Flux still desires. `console-app` depends on the successful migration Kustomization; migration depends on the database, secrets and admission policies.
- `base/database`, `base/objects`: CNPG's application role contracts and managed password references; SeaweedFS with a persistent volume; an idempotent bucket-initialization Job. The Barman Cloud plugin uses an ObjectStore defined by the overlay.
- `base/namespace`, `policies`: restricted PSA, deny-by-default NetworkPolicies, file-mounted secrets, non-root processes, read-only root filesystems, resource budgets, probes and VAP/OPA rules. Image admission requires the exact build workflow identity, provenance and SBOM. Upstream images have a finite digest allow-list. The policy-controller is opt-out; only explicitly labelled platform/system namespaces are excluded.
- `base/platform`: generated plain manifests for Flux (source, kustomize, notification only), Rollouts, CNPG, ESO, Sigstore policy-controller, cert-manager and Barman. No runtime Helm controller.
- `clusters/exit-test`: synthetic data and runner-sized settings. `clusters/template`: schema-valid `.invalid` hosts and named placeholders, External Secrets references and no credentials. Replace its storage class, secret-store reference and remote paths before a future environment adopts it. P0 creates no such consumer.
- `source/oci.yaml`: source-verification template. CI binds both image admission and Flux verification to the current repository's exact `platform.yml@refs/heads/dev` identity. `reconcile/` carries the dependency graph. The artifact revision records the source git SHA and immutable image digest.

`versions.json` owns binary URLs/checksums, Kubernetes schemas, upstream source hashes and image digests. Required Dockerfile image arguments come from that lock. Do not edit generated add-on YAML or JSON schemas: run `node deploy/ci/vendor.mjs` with the locked tools. For a deliberate version bump, update the source/tool pins, then run `node deploy/ci/vendor.mjs --update-images` and review the resulting digests. Upstream licenses remain Apache-2.0 (Flux, Rollouts, CNPG, ESO, policy-controller, cert-manager, Barman, SeaweedFS, Kubernetes); generated files retain upstream copyright text where present. Upstream schemas are vendored for offline, strict kubeconform checks, with no missing-schema bypass. The recursive CRD schema is derived from checksum-pinned Kubernetes OpenAPI.

## Class B and negative controls

A successful publish immediately starts class B; weekly and manual `dev` runs consume the existing shadow artifact without pushing or signing. The matrix runs two independent fresh kind clusters on each native architecture. kind is Apache-2.0 and is the lighter fallback allowed by the ADR. The first publish seeds the prior-release baseline. A second distinct `dev` image is required: `PLAT_PREVIOUS_RELEASE` refuses to call a first-release install a proven N-1 → N promotion.

Each cluster verifies and freezes the signed artifact digest, bootstraps only Flux, and lets Flux install the controllers, policies, objects, database, migration and app. Credentials are random per run and are streamed to the disposable cluster; none are written into the artifact or evidence. Real console HTTP tests check the Korean web shell, all four database pools, absence of dev-auth, and cold-start sign-in plus OTP replay refusal. A successful N-1 → N Rollout must produce a new successful AnalysisRun. A readiness fault must abort while stable replicas remain; Flux then restores the desired template. Barman backs up the synthetic account/schema to authenticated in-cluster SeaweedFS, and a new CNPG `bootstrap.recovery` cluster must recover matching user and migration counts.

| Control | Required evidence (unrelated errors do not count) |
| --- | --- |
| Unsigned image | The same hardened Pod is accepted with the signed digest and refused by `policy.sigstore.dev` with the identical image published in the unsigned fixture repository. `unsigned-image.txt` contains the signature-verification refusal. |
| Other image signer | The negative workflow copies the identical image index to its own fixture repository, signs it and attaches both required attestations. Cosign verifies that workflow's signature before admission must refuse the image. `wrong-image-signature.json` and `wrong-image-identity.txt` preserve the signature and refusal; missing attestations cannot substitute for the identity control. |
| Other workflow identity | The reusable `platform-negative-signer.yml` signs different artifact bytes. Cosign first verifies that distinct workflow identity. A Flux source retaining the trusted platform identity must report `Ready=False`, reason `SourceVerificationFailed`. Both signature and Flux condition JSON are saved. |
| Hand edit | Scale the synthetic worker to zero; request Flux reconciliation; assert that Flux restored the artifact's replica count. `drift.txt` records the edit, desired count and read-back. |
| Workload admission | Server dry-run accepts the hardened Pod, waits until the first known-bad Pod is refused (bounded to 60 seconds), then refuses each of the eight `PLAT_*` mutations with its exact code. This runs on PRs as well as class B; CEL warnings fail the test. |

`class-b-<arch>-<repetition>` evidence includes those controls, HTTP results, Rollout/AnalysisRun JSON, restore counts, source revision, reconciliation and workload states, events, elapsed seconds and disk use. All operations are guarded to `kind-platform-*` contexts. No success is claimed from offline schema tests alone. kind's default CNI does not prove Cilium's traffic enforcement; that denied-flow test belongs to P1.

On failure, cleanup prints and saves `diagnostics.txt` before deleting the cluster: reconciliation conditions (including HelmReleases when installed), workload states, failing pods' state-only descriptions, the last 100 log lines per container (including restarted containers' previous logs), and events. Secret values are read only into memory for redaction; specs, environment values and annotations are omitted. If the Secret inventory is unavailable, free-text diagnostics are suppressed while state collection and cleanup continue. Diagnostic errors preserve the original failure status.

Run 40331122022 failed before database reconciliation: its `platform` condition reported `ServiceAccount/argo-rollouts namespace not specified`. The generator now applies explicit namespaces to upstream manifests, including the policy-controller PDB. The database bootstrap also provisions the dormant, non-login `console_auth_cmd` required by migration 0232; no credential or membership activates it. Render tests cover both overlays and migration grantees.

## Local and verifier checks

```sh
python3 deploy/ci/tools.py
export PATH="$PWD/.tmp/platform/bin:$PATH"
actionlint .github/workflows/platform.yml .github/workflows/platform-negative-signer.yml
shellcheck deploy/ci/*.sh
python3 -m unittest discover -s deploy/ci -p '*_test.py'
node --test deploy/ci/*.test.mjs
bash deploy/ci/validate.sh
npm run check
```

For fail-before, create a detached worktree of the pre-fix commit outside the product repository and set `PLATFORM_BASE_WORKTREE` to its path:

```sh
PLATFORM_REPO_ROOT="$PLATFORM_BASE_WORKTREE" node --test deploy/ci/*.test.mjs
```

The verifier must run the full Actions workflow on the merge result: both native builds, VAP server dry-run, two distinct dev publications for the N-1 baseline, and class B twice per architecture with the rejection evidence. Each build checks Docker's native architecture before building from the same Dockerfile and admitted context; no emulation satisfies this gate. Local checks cannot supply GitHub OIDC or a native AMD64 runner. The existing IaC gate audits the Flux manifest directories, and the source gate permits only the upstream Rollouts plugin mount while still refusing machine paths in that manifest. No application crate or web source changed, so crate DB tests are not implicated by this slice.

## CI glue ledger

These are build/generation/test glue, never production maintenance entrypoints. Owner: platform P0. No host script or runtime reconciler is introduced.

| Glue | Why a declarative object is insufficient | Retirement |
| --- | --- | --- |
| `tools.py` | Verify locked downloaded bytes before executing binaries | Replace with the approved pinned toolbox at P1 if it covers both architectures |
| `vendor.mjs` | Render upstream chart/release inputs and derive pinned schemas | Keep as the reproducible asset generator; remove schema conversion when upstream publishes the recursive standalone CRD schema |
| `render.mjs`, `sbom.mjs` | Bind the built digest/identity to the transport tree and combine native SPDX documents | Replace with promotion's native rendering/aggregate-SBOM support at P1 |
| `validate.sh`, `image-smoke.sh` | Invoke the validators and the native executable's HTTP/exit contracts | Fold into the shared CI toolbox at P1 |
| `exit-test.sh`, `diagnostics.mjs`, `admission.mjs`, `image-admission.mjs`, `synthetic.mjs`, `canary.mjs`, `restore.mjs` | Inject and assert disposable negative controls, synthetic data and recovery; print redacted failure evidence before cleanup | Keep as class B tests; never install on a node |
