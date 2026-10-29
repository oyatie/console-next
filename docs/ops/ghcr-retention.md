<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# GHCR retention

Slice 1 provides a read-only inventory and the shared retention planner. Run
`node scripts/ghcr-retention.mjs --dry-run` for a version-by-version Markdown report,
or `--json` for machine-readable evidence. Exit 2 means a safety hold; exit 1 means
the command failed. No version is deleted, and `--apply` is explicitly refused.
The required CI web job runs `node --test scripts/ghcr-retention.test.mjs`.

`scripts/ghcr-retention.config.json` is the one settings file: package scope,
K distinct recent dev builds per package, inventory concurrency, and the minimum
distinct roots from each required keep source (including N rollback releases).
The planner retains production, canary, staging, rollback, exit-test N-1 and
in-flight roots, their architecture manifests, OCI subject/referrer graphs,
Cosign `.sig`/`.att`/`.sbom` tags and OCI fallback index tags. Recent dev builds
are identified by the publisher's commit tags or OCI revision annotations.
An unavailable source or incomplete protected graph holds **every** package.
Bytes count unique compressed referenced blobs and manifests within each package;
they are observable registry content, not GitHub's physical storage/billing metric.
Registry traversal follows the [OCI referrers API and fallback tag schema](https://github.com/opencontainers/distribution-spec/blob/main/spec.md#listing-referrers)
and [Cosign's registry storage conventions](https://docs.sigstore.dev/cosign/system_config/registry_support/).

The live command intentionally holds everything until source integration lands.
Keep sources are released digests from the promotion refs, exit-test N-1,
active release candidates and the last K dev builds. Promotion refs must cover
environment targets and rollback releases; a hand-maintained digest allow-list or
the last N ordinary dev commits cannot substitute for rollback release records.
The next slice must read only public GitOps refs, retaining the referenced deploy
artifact and its image, exit-test N-1 and the configured last K dev builds before
producing any deletion candidates. Missing sources must remain a hold.
A final slice adds the weekly/default-dry-run workflow and
reviewed apply mode, including protection against concurrent publication/promotion.

## Token and recovery

[GitHub's package permissions documentation](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages)
allows `GITHUB_TOKEN` to delete and restore packages. Use workflow
`packages: write`, with the workflow repository granted **Admin** under each
package's **Manage Actions access**. A repository link or Write role alone does
not establish Admin access. Workflow-published packages grant their publishing
repository Admin by default, but existing grants must be checked before apply.
If absent, the minimal owner action is to grant `oyatie/console-next` Admin on
each managed package; no long-lived PAT is needed.

[GitHub's delete/restore guide](https://docs.github.com/en/packages/learn-github-packages/deleting-and-restoring-a-package)
states that restore is available within **30 days**, provided the namespace/version
has not been reused. Public versions with more than 5,000 downloads require
GitHub Support for deletion. Preserve the report's package name, version ID and
digest before any future apply. With authorized package Admin credentials, restore
using the documented [Packages REST endpoint](https://docs.github.com/en/rest/packages/packages#restore-package-version-for-an-organization):
`gh api --method POST /orgs/ORG/packages/container/URL_ENCODED_PACKAGE/versions/VERSION_ID/restore`.
Restore the image index, architecture children and its proof/referrer versions,
then verify signature/admission and pull by digest before attempting a rollback.
