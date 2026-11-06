<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Test tiers

This is the canonical tier table. CI wiring belongs to CI-1; this table describes the delivery contract,
not a claim that every tier is already wired in the public workflow.

| Tier | Proof | Trigger / budget |
| --- | --- | --- |
| Docs only | Documentation checks and both build families | Documentation-only changes use conservative affected-path classification |
| Fast | Types, lint, affected unit/component tests, contract and ratchet gates; affected API/DB binaries | PRs and fix rounds; affected only |
| Rust non-database | Every default-feature workspace test without a database; nextest JUnit reconciled against a fresh inventory | Affected PRs and merge results; dev pushes reuse the successful merge result; target ≤ 10 min wall, shard by measured duration above 5 min execution |
| PR browser | Affected critical journeys and first-run-solo smoke, Chromium and Firefox | Every PR; ≤ 8 min wall including stack startup |
| Queue browser | Affected checks, journey smoke, solo first-run gate, route smoke and a no-new-reds sweep | Landing / merge result; browser smoke within the PR budget |
| Full widening | Full suite for migrations, contracts, Cedar, auth/tenancy and tooling changes | When the change affects these shared boundaries |
| Release / nightly | Full DB suite and full Chromium/Firefox E2E | Once per release unit and nightly; E2E ≤ 15 min wall including startup |
| Scheduled | Mutation, soak, chaos and fuzz | Separate scheduled jobs |

Owner policy (2026-10-15): select crates through the workspace dependency graph, web tests through the import
graph and E2E through the feature map (the screen registry's spec-to-route map), plus first-run-solo smoke.
Fix rounds run affected checks; landing adds smoke and the no-new-reds sweep; releases and nightly run everything.
When unsure, widen the checks. Record a skipped suite as **not affected**, with evidence, never as a pass.

See [E2E strategy, measurement protocol and current evidence](e2e.md) for browser selection, tagging,
flake accounting and the distinction between current behaviour and the target.

See [known live test failures](known-live-reds.md) for current reproductions and follow-ups.

`ci` checks PRs and merge groups; dev pushes import a successful same-repository queue run with the same Git tree and the push base in its ancestry. Missing proof fails closed. Web checks and mocked states use the web affected flag; documentation Markdown selects both build families. Solo journeys and write/beacon probes remain queue gates; grid-table remains in the required web check. The nightly live inventory excludes these copies; Firefox write/beacon coverage stays nightly because the queue probes use Chromium. Actionlint runs once through the required reusable workflow check; the build owns TypeScript compilation.

Push jobs refresh state timings, promote the proven backend and tool artifacts, and save browser/Rust caches. D7/D8/D10 normalization shares one job when both report families exist; partial changes deliberately skip that normalization and retain previous evidence with its original timestamp. Every successful dev run retains a backend artifact for Home, including web-only and documentation-only pushes. Release admission still consumes the successful dev `ci` run.
