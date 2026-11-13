<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Actions cache retention

`scripts/cache-retention.mjs` owns Actions cache planning and deletion. Policies in
`scripts/cache-retention.config.json` state each family's purpose, readers and
copy counts. The existing `platform.yml` cleanup job sweeps all families on each
dev push; post-job saves are collected by the next push. The Rust producer in
`ci.yml` also plans immediately after a successful merge and save. Neither cleanup
failure can block delivery; failed or skipped cleanup writes a summary warning.

| Family | Reader | Retained copies per cache version |
| --- | --- | --- |
| backend | Rust checks, tests, release and collector on dev/PRs | Two per runner, with the current saved prefix and saved/restored keys protected |
| db-tests | DB test shards | One per runner/debug profile |
| npm | setup-node in all workflows | One per OS/architecture |
| playwright | Web and states browser jobs | One per OS/architecture/browser |
| codeql | Overlay analysis | One per language |
| buildkit | Native image builds | Two indexes per architecture/scope; shared blobs bounded by build access |

Only the configured newest compatibility prefixes retain their configured fallback
copies. Old lockfile hashes do not each reserve an archive. Rust first restores
its current manifest prefix, then the runner prefix, so the previous manifest's
archive can warm the first build after a manifest change. Concurrent saves may
require extra protected entries; the summary reports their actual byte cost.
Before merging deltas from a different manifest/toolchain prefix, the collector
discards restored targets so obsolete metadata-hashed outputs do not accumulate
across compatibility changes. Downloaded crates remain reusable.
Caches contain rebuildable inputs and targets, not release rollback evidence.

Legacy image indexes have no reader and are removed. BuildKit's `blobBuilds`
sets a build-count window. The older of the configured scopes' Nth-newest index
defines its boundary; a blob survives if created **or accessed** at or after it.
Both scopes retain that many indexes so the next sweep can still establish the
boundary. Missing access metadata refuses the entire sweep before deletion.
Incomplete scope history or unrelated indexes preserve shared blobs. A legacy-only
inventory with no other index can reset its blobs. The REST API exposes access
timestamps, not a reference graph; access must be verified before enabling this
family. Unknown cache
families and non-PR branch refs are preserved. Superseded dev entries and known
families' PR merge-ref entries are eligible for deletion.

GitHub scopes caches by key, version and branch; prefix restoration selects the
most recently created compatible entry. See GitHub's
[cache matching and access rules](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).
The planner uses the paginated [cache REST API](https://docs.github.com/en/rest/actions/cache)
and deletes by ID, tolerating an already-evicted ID (404). Other API failures stop
cleanup. A producer inventory missing its saved key refuses cleanup before deletion.

Cleanup defaults to dry-run. Each summary lists keep/delete IDs, purpose, readers,
count policy, observed usage and projected usage against the configured target.
A projection never changes the observed budget status. Rust readers report
`exact hit`, `warm fallback` or `MISS`, identifying the actual restored key.

Before enabling deletion, review the dry-run keep set and three consecutive dev
restores plus a PR restore. Each family has its own repository variable:
`CACHE_RETENTION_BACKEND_APPLY`, `CACHE_RETENTION_DB_TESTS_APPLY`,
`CACHE_RETENTION_NPM_APPLY`, `CACHE_RETENTION_PLAYWRIGHT_APPLY`,
`CACHE_RETENTION_CODEQL_APPLY`, `CACHE_RETENTION_BUILDKIT_APPLY`. Only the exact
value `true` enables that family; unset it to return to dry-run. The old global
switch has no effect. For BuildKit, compare inventories spanning consecutive
platform builds: reused old blobs must advance `last_accessed_at`; then confirm
the next platform log imports without a missing blob. The committed consecutive
public inventories show this access advancement across exports #75 and #76.
Repeat the comparison with current inventories before the first apply and have
the orchestrator review the complete keep set. Only workflows perform live
pruning. GitHub describes this approach in
[managing caches](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manage-caches).
The public history replay fixture records dev pushes and manifest fingerprints;
at measured archive sizes, with 110 MB of new blobs per build and reused base
layers, it verifies the configured target after every prune. This is a replay,
not proof of future warm restores or a hard byte cap on individual archives.
