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

- Rebased onto public `dev` at `d4895616`, replaying only this slice's three
  commits rather than the old snapshot history.
- `BACKLOG_QUEUE_DIR` points to the lane's empty queue (`index.json`: `[]`).
  CI-0 now reads the versioned reach-unit registry. The public base and tip
  both pass with identical output: 36 paths, 53 baselined gaps, 28 editable
  labels, 119 uncalled release operations and 167 owned allowances. The old
  train's identical base/tip queue refusals remain recorded in `proof-r2/`;
  they no longer occur after this rebase. `UNTRACKED` stays at 45 on base/tip.
- The two focused regressions fail at pre-fix `68c1ba78`: the census lacks
  "등록증 보며", and the copied original closure report omits the API/export
  remainder. Both pass at the tip. This remains registry/report proof.
- Reach tests pass 22/22 on the public base; the tip's reach and regression
  tests pass 24/24. All 1,565 unit tests pass, including browser-backed tests
  run outside the sandbox so Chromium can launch.
- The shared local `dev` still names an unrelated snapshot. The exact
  `npm run check` command runs in the lane's isolated `ci-tip` checkout,
  whose local `dev` names the public base, as in CI. No shared ref is changed.
- The rebased `ci.yml` runs `cargo fmt --check` and `cargo clippy --workspace
  --all-targets --locked -- -D warnings`, with no additional feature sets.
- Playwright discovers 25 cases across the five verifier specs, including
  14 propagation cases. Discovery is not a browser execution result.

Local command logs and base comparisons are in the lane folder's `proof-r3/`.
Files outside the queue brief's owns: this report and
`scripts/record-actions.test.ts`. No excluded or generated files were edited.
