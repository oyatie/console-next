<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Image build cache

The platform workflow imports the GHA v2 cache in the `console-platform-<arch>`
scope. Only pushes to the repository's default branch export it, using `mode=min`.
PR and merge-group builds only import; they cannot create merge-ref caches that
other PRs cannot reuse. The workflow's push trigger selects `dev`.

Docker recommends a distinct [scope per image](https://docs.docker.com/build/cache/backends/gha/#scope).
Architecture is also part of our scope because each matrix runner builds one
native image. BuildKit's content keys invalidate changed Dockerfile inputs;
adding the commit SHA or a run ID to the scope would prevent reuse.
The existing runtime credential export and pinned Buildx/BuildKit support
[GHA API v2](https://docs.docker.com/build/ci/github-actions/cache/#github-cache).

[`mode=min`](https://docs.docker.com/build/cache/backends/#cache-mode) exports only
final-image layers, avoiding the large intermediate Rust and npm build layers
that `mode=max` retained. This reduces storage and transfer cost, but intermediate
compilation may still run on hosted runners. Compare build duration and actual
`CACHED` vertices before deciding whether a different existing backend is needed.
No registry cache is introduced: its cost and retention have not been measured.

## Legacy cleanup

On a default-branch push to `dev`, `prune-image-cache` runs alongside the native
builds. PR and merge-group runs skip maintenance.
It removes the old `platform-amd64` and `platform-arm64` indexes, including PR
indexes. If these are the only image indexes, it also resets the legacy BuildKit
blobs once, allowing the smaller caches to repopulate on this run. If any new or
unrelated image index exists, shared blobs are preserved. npm, Cargo, CodeQL and
unrecognized key families are never selected. PRs receive no cleanup write token.

The script snapshots every page before deleting by ID; already-evicted entries
are tolerated, while permission and transport failures fail the cleanup step. The exact
deleted count and bytes appear in the job summary. Cleanup failures produce a
summary warning while builds and publishing continue. Promotion still requires
completed, successful evidence for every job, including cache maintenance.
The key shapes follow the existing
[BuildKit GHA exporter](https://github.com/moby/buildkit/blob/master/cache/remotecache/gha/gha.go).
The [GitHub cache API](https://docs.github.com/en/rest/actions/cache) requires
Actions write permission for deletion; that permission belongs only to cleanup.

[GitHub cache scoping and eviction](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
allow PRs to read default-branch caches, isolate PR-created caches to their merge
refs, and evict least recently accessed entries above the configured repository
limit (10 GB by default). Unused blobs expire under GitHub's retention policy;
the subsequent cache-budget slice must measure total usage, including these blobs.

## Hosted proof

Use this PR's platform runs, then at least three default-branch runs after merge.
Record the cold and warm duration of `Native image and GHA cache` for both
architectures and count `CACHED` build vertices in its plain-progress log.
Do not report cache-index existence as a layer hit. Record cache-list bytes by
family before and after cleanup; its summary reports reclaimed bytes.

Local BuildKit retains its internal cache without GHA credentials; normal local
builds should reuse their existing builder. These workflow flags apply only in
Actions. Cargo cache sharing, local Rust tuning, per-job cache summaries and the
scheduled budget guard are separate changes.
