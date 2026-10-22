<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->

AD-F02 #47 registry slice — review fixes, 2026-10-22

This slice guards the UI surfaces registered in `facts.ts`. #47 remains open.
It does not close plan W2 E1 or AD-ENT01 #51; S3 entity revision is still pending.
This report supersedes the earlier w2-e1 report's claim of complete coverage.

Remainders:

- 2026-10-22 — API + export surfaces: `GET /api/v1/employees` and
  `GET /api/v1/employees/export.csv` are not registered or checked for the three
  legal-entity name fields. Both currently expose a `company` snapshot without
  alias fields; defining those response contracts and their propagation proof
  remains open. Review F2 option 2 applies.
- 2026-10-22 — CX dependency (F3): assert exactly one `legal_entity.revise`
  audit with its revision for each name edit in a backend DB test.
- 2026-10-22 — INTEG dependency (F3): root-cause the parallel Firefox failure
  in `entity-name-evidence.spec.ts` (the individual's 상호 case). A focused
  passing rerun does not resolve it.

The new local tests prove the certificate-edit census entry and this explicit
remainder report. Their fail-before result is registry/report proof, not a
reproduction of a product propagation defect. The existing planted E2E cases
must still detect a stale UI surface.

The verifier must run these served E2E specs twice per engine (Chromium and
Firefox, with parallel workers for the evidence spec):

- `e2e/record-actions/propagation.spec.ts` (each fact in setup and live phases,
  plus both stale-surface plants)
- `e2e/record-actions/reach.spec.ts` (both census phases)
- `e2e/entity-name-evidence.spec.ts`
- `e2e/entity-name-en.spec.ts`
- `e2e/first-run-solo.spec.ts`

Check the certificate card for intentional old-name history before treating
an old-name assertion as a product failure. Capture each edited UI surface in
place and after reload, including English presentation and long-name wrapping.
The full merge-result CI proof and all remainder work remain required for #47.

Re-run evidence, 2026-10-23:

- Rebased onto `train/fix-r1` at `5b15c3a8`.
- Without `BACKLOG_QUEUE_DIR`, both that base and the rebased tip emit the
  identical "no orchestra queue" refusal. With the lane's empty queue
  (`empty-queue/index.json` containing `[]`), both emit the same 53 missing
  open-lane references, byte for byte. These are inherited queue dependencies.
- `npm run check` was run with that queue and stops at the inherited reach
  diagnostics. Its subsequent commands were run separately, without changing
  the gate, the baseline, or the queue claims.
- The unit run and focused browser rechecks cover 1,530 passing tests of
  1,532; only the two inherited reach tests remain red (19/21 also on the
  base). Four browser-backed suites could not launch Chromium in the sandbox
  and passed outside it. The 16 Node workflow/secrets tests also pass.
- Typecheck, lint, build, bundle budget, full-history/build secret scans,
  licence headers, fixture IDs and dependency licences pass. Both existing
  lint warnings are outside this slice. `UNTRACKED` stays at 45 on base/tip.
- CI's `cargo fmt --check` and `cargo clippy --workspace --all-targets
  --locked -- -D warnings` pass; this CI file lists no additional feature
  sets. `cargo check --workspace --tests` passes too.
- File-size: 2,266 files measured, 303 pins, zero violations against the
  train base. The AI-quality ratchet also passes against that base.
- Both focused regressions fail at the pre-fix `eaf3d141`: the census lacks
  "등록증 보며", and the earlier report incorrectly claims no remainders.
  They pass on the rebased tip. This remains registry/report proof.
- Playwright discovers 14 propagation cases: six facts in each phase and
  two stale-surface plants. Discovery is not a browser execution result.

Local command logs and base comparisons are in the lane folder's `proof-r2/`.
Files outside the queue brief's owns: this report and
`scripts/record-actions.test.ts`. No excluded or generated files were edited.
