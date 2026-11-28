<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Overtime work-rule confirmations

An employer can record its rule, work-rules clause, confirmation date and worker notification method in Settings. Setup tracks whether a confirmation was recorded or the step was skipped. The step is optional for go-live.

The policy resolver uses the nearest applicable confirmation. A configured approval basis reads as recorded through the confirmation date, and as approval from the next work date. A recorded-basis override stays recorded. These are employer policy records. The settings adapter's PostgreSQL test checks the confirmation date and the following work date for a person under the confirming workplace. [Policy test](../../backend/crates/settings/adapter-postgres/tests/wave2_policy.rs)

## Current calculation

The attendance engine calculates worked minutes from segments after breaks and confirmed non-work. An open excess interval remains visible. Day, month, edit preview and weekly projections use the attendance calculation. Payroll calculates from the run's imported wage amounts and attendance source hours. A confirmation writes no payroll amount, settlement decision or correction. [Recognition domain tests](../../backend/crates/attendance/domain/src/records/recognise_tests.rs) · [Day, preview and month PostgreSQL test](../../backend/crates/attendance/adapter-postgres/tests/records/recognition_reads.rs) · [Weekly PostgreSQL test](../../backend/crates/attendance/adapter-postgres/tests/records/week52.rs) · [Pay-run source amounts](../../backend/crates/payroll/adapter-postgres/src/lifecycle_amounts.rs)

## Design D settlement target

The attendance decisions in Design D specify that approved worked overtime enters settlement, undecided minutes at a pay group's cutoff are held for later settlement, and a later approval creates arrears. The design calls for recalculation of a corrected, unapproved run before its pay date and an adjustment after approval. The statutory citation stored with a confirmation defaults to “Labor Standards Act Articles 50 and 53”. The attendance board reserves counsel review of the tacit-approval warning and the wording describing the effect of rejecting worked time. The board also leaves open the effect of rejecting a prior application when work was subsequently recorded. [Design D board inventory and source fingerprint](../ui-target/release-audit/README.md)

Before using confirmations for settlement, the product owner must resolve that prior-application case and approve the worker-facing wording with counsel. Payroll also needs an authoritative amount source for dated approved minutes when imported overtime amounts are already present, and a way to post each held interval to the correct later group run exactly once. Keep the source work intervals, approval or rejection evidence, and locked historical run separate so a later decision can be reconciled.
