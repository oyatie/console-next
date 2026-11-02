<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Dependabot cargo group #315 — migration required

Reviewed 2026-11-02 against dev `42e2bb645` and [#315](https://github.com/oyatie/console-next/pull/315)
head `f8a56ce5948e878f8d9a2b411787e70dbad5b050`.

Disposition: **close-with-reason; Apalis needs its own migration slice**. Keep the backend
pins unchanged and adopt the compatible desktop patches separately, without changing dependency approvals.

Ready-to-paste close reason:

> Closing this mixed group: Apalis 1.0.0 needs an audited schema/ACL and adapter migration,
> beyond a version bump. All Apalis updates are temporarily ignored until that migration
> passes upgrade and runtime-role tests. The Tauri 2.5.4 single-instance and
> 2.6.3 deep-link patches are adopted separately without the Apalis updates.

## Reproduced failure

The [CI backend job](https://github.com/oyatie/console-next/actions/runs/41272049258/job/124746641621)
fails at `cargo clippy --workspace --all-targets --locked -- -D warnings`.
The [amd64](https://github.com/oyatie/console-next/actions/runs/41272049140/job/124746641542)
and [arm64](https://github.com/oyatie/console-next/actions/runs/41272049140/job/124746641656)
image builds fail for the same dependency error.

Locally, the exact clippy command on the fetched PR head fails with E0432 in
`apalis-sql 1.0.0-rc.9`: `apalis_core::backend::poll_strategy`,
`apalis_core::task::metadata::MetadataExt` and `apalis_core::task_fn` no longer exist.
The group upgrades `apalis` and `apalis-postgres` to stable while retaining prerelease
`apalis-sql`; the lock resolves their shared `apalis-core` to 1.0.0.

## Why a compile fix is insufficient

Comparing the published [rc.8](https://crates.io/api/v1/crates/apalis-postgres/1.0.0-rc.8/download)
and [1.0.0](https://crates.io/api/v1/crates/apalis-postgres/1.0.0/download) crate sources shows:

- `PostgresStorage::new_with_config` becomes `new(...).with_config(...)`; task builders
  and metadata move out of the old SQL extension API. The PostgreSQL pool moves from
  SQLx 0.8.6 to 0.9.0, affecting the adapter's dedicated runtime pool and release hook.
- Migration `20220530084123_jobs_workers.sql` changes its schema statement, changing
  a historical checksum. The console deliberately rejects unexpected ledger checksums.
- Migration `20260605000000_confine_generate_ulid_to_apalis.sql` replaces
  `public.generate_ulid()` with `apalis.generate_ulid()`. Existing reconciliation and
  ACL validation explicitly reference the public function.
- Migration `20260826101335_metadata_hstore.sql` creates the `hstore` extension,
  converts job metadata from JSONB and drops the old column. This needs data-preservation
  and extension-ownership proof, with a recovery plan before rollout.

## Follow-up and revisit trigger

Keep the current exact prerelease pins. `.github/dependabot.yml` ignores all updates
of `apalis`, `apalis-postgres` and `apalis-sql`, including prereleases: [#338](https://github.com/oyatie/console-next/pull/338)
re-proposed `apalis` rc.12 and `apalis-postgres` rc.10 alongside `apalis-sql` rc.9,
again resolving `apalis-core` to 1.0.0 and failing at the same imports. Other Cargo bumps, including
both Tauri patches, remain enabled. Remove these ignores when a dedicated migration
slice preserves existing queued jobs, idempotency, timers, restart/crash recovery,
ledger tamper refusals and runtime-role isolation on both upgraded and fresh databases.

That slice must reconcile the historical checksum explicitly without weakening the
general refusal, migrate metadata and function ACLs through the existing owner path,
adapt the worker/task and pool APIs, and remove obsolete prerelease-only declarations.
Run `console-platform-jobs` integration binaries `apalis_adapter`, `apalis_schema_contract`,
`apalis_runtime_release` and `status`, the `console-apalis-soak` harness and direct dispatch
consumers, then CI clippy/check and native amd64/arm64 image builds. Any changed access decision remains subject to
the Cedar directives; this disposition introduces no access decision.
