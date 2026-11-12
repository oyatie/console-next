<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Actions cache retention

The Rust cache producer in `ci.yml` maintains the `backend` policy in
`scripts/cache-retention.config.json` after a successful merge and save. Readers
are the Rust check, test, release and collector jobs on dev, PRs and merge groups.
The archive contains downloaded crates and compiled targets; it is not release
evidence. Retention does not change cache keys or archive paths.

The shared planner keeps the newest two archives per runner family and cache
version, and the newest one per compatible restore prefix and version. It also
protects the producer's saved and restored keys, including during concurrent
builds. These sets overlap; they are not a global two-archive limit. Keeping each
compatible prefix preserves the fallback used by a PR with an older lockfile.
Only superseded archives in this family on dev and this family's PR merge-ref
archives are eligible for deletion. Other families and branch refs are preserved.

GitHub scopes caches by key, version and branch; prefix restoration selects the
most recently created compatible entry. See GitHub's
[cache matching and access rules](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).
The planner uses the paginated [cache REST API](https://docs.github.com/en/rest/actions/cache)
and deletes by ID, tolerating an already-evicted ID (404). Other API failures stop
cleanup. An API inventory that does not contain the saved key refuses cleanup.

Cleanup defaults to dry-run. Each producer summary lists the keep/delete IDs,
purpose, readers, count policy, observed usage and projected usage against the
configured 70% target. A projection never changes the observed budget status.
Rust readers report `exact hit`, `warm fallback` or `MISS`; an exact-key miss
that restored a fallback is warm. These lines identify the actual restored key.

Before enabling deletion, review the dry-run keep set and hosted restore logs.
Set repository variable `CACHE_RETENTION_APPLY=true` to let the dev producer apply
its plan; unset it to return to dry-run. No branch or manual local invocation
should perform a live prune. GitHub documents workflow-based cleanup in
[managing caches](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manage-caches).

The planner preserves warmth before attempting to meet the byte target. New
compatibility prefixes and cache versions can increase the retained size; the
summary stays over budget when this happens, so operators can reduce archive
size or explicitly retire obsolete compatibility policies with reader evidence.
