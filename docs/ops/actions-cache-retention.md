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
| buildkit | Native image builds | One index per architecture/scope; shared blobs remain protected |

Only the configured newest compatibility prefixes retain their configured fallback
copies. Old lockfile hashes do not each reserve an archive. Rust first restores
its current manifest prefix, then the runner prefix, so the previous manifest's
archive can warm the first build after a manifest change. Concurrent saves may
require extra protected entries; the summary reports their actual byte cost.
Caches contain rebuildable inputs and targets, not release rollback evidence.

Legacy image indexes have no reader and are removed. Shared BuildKit blobs are
reset only when legacy indexes exist and no current or unrelated index exists.
The cache REST inventory does not expose blob references, so pruning an individual
blob behind a live index would risk a cold or incomplete restore. Unknown cache
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
restores plus a PR restore. Set repository variable `CACHE_RETENTION_APPLY=true`
to apply the plan; unset it to return to dry-run. Only workflows perform live
pruning. GitHub describes this approach in
[managing caches](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manage-caches).
The public history replay fixture records dev pushes and manifest fingerprints;
at measured archive sizes it verifies the configured target after every prune.
