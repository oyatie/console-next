<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Dependency ruling — 2026-10-26

Source: the 2026-10-26 dependency standard review, final orchestrator ruling under the owner's delegation. The research snapshot's earlier 33/114 totals are superseded by this final ruling:

> Approved as STANDARD (29): every row in table 1 except opentelemetry, opentelemetry_sdk, opentelemetry-otlp and tracing-opentelemetry, which move to NEEDS-OWNER (opentelemetry.io lists the Rust traces SDK as "Beta": not clearly the golden standard). react, @playwright/test and Rust were already owner-approved.

The owner may overturn any delegated approval. The [register](dependency-register.md) and its JSON retain each direct row's primary sources and dated research evidence; the [owner summary](dependency-owner-summary.md) contains only the 118 unresolved direct dependencies. Transitive names are inventory without independent rulings. Gates and vendored CI sources are not part of these 147 dependency decisions.

The [backend](../architecture/backend-module-map.md) and [frontend](../architecture/frontend-module-map.md) maps record each approved dependency's home layer, exact users, permitted use contexts, approving ruling and exit plan. Shared identifier/serialization/async vocabulary can flow to explicitly named outer rings; boundary APIs can be used by named adapters and platform composition roots. Test contexts are named separately. Framework types remain prohibited in domain and use-case code. Observed inward JSON/base64 and other out-of-scope uses remain register findings, with no new boundary exception or permission to expand them.

Approval of Rustls, Tokio Rustls and Zeroize is limited to their existing adapter/credential jobs; it does not put mail in release scope. The final ruling also leaves the six observability dependencies awaiting an owner decision. No dependency or gate was added, removed or swapped by this reconciliation.

Research limits remain visible: the review did not inspect pinned image contents; some licences and security-process details were unverified. Source timestamps describe the research snapshot, not a fresh registry query. Existing layer enforcement is unchanged; the later approval-gate slice will enforce the architecture records.
