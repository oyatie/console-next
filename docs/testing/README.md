<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Test tiers

This is the canonical tier table. CI wiring belongs to CI-1; this table describes the delivery contract,
not a claim that every tier is already wired in the public workflow.

| Tier | Proof | Trigger / budget |
| --- | --- | --- |
| Fast | Types, lint, unit/component tests, contract and ratchet gates; affected API/DB binaries | Every PR and merge result |
| PR browser | Affected critical journeys, Chromium and Firefox | Every PR; ≤ 8 min wall including stack startup |
| Queue browser | Journey smoke, solo first-run gate and route smoke | Merge queue; within the PR budget |
| Release | Full DB suite and full Chromium/Firefox E2E | Once per release unit; E2E ≤ 15 min wall including startup |
| Scheduled | Mutation, soak, chaos and fuzz | Separate scheduled jobs |

See [E2E strategy, measurement protocol and current evidence](e2e.md) for browser selection, tagging,
flake accounting and the distinction between current behaviour and the target.
