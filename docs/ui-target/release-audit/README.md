# Console Design D release audit

Snapshot on 2026-11-28. PR 930 was open at `aa58f9ae0d60b5fdf5696ec5a66d5f056c5221fe`. PR 931 was originally inspected at `f3eccfae9dd770dc86a8c68c41bb7b373140ca61`. The follow-up reviewed `a764a7a264`. The dev revision under review was `c88215197712c45bd92b21d2b1fd704b4cf74d20`.

## Coverage

The supplied local board export has SHA-256 `3e8cd3ad65f3c7d83c81b6546f213f60055ec861b5452561dc91cf4a134caceb`. Git does not track that HTML at the reviewed PR revision. Its embedded records contain 373 entries and 161 distinct board definitions. Of the 296 non-deferred entries, 12 carry the “Approved board” label, 171 “Proposed board”, 10 “Layout brief”, 6 “State proposal” and 97 “Shared view”. The other 77 are marked “Deferred”.

The [coverage inventory](coverage.csv) includes all 373 entries in the export’s original order, preserving repeated addresses for distinct states and views. It uses the English titles from the bilingual source to identify entries. It records each board’s source and screenshot references, literal address matches in checked-in route sources, and exact method/path matches in the tenant and operator OpenAPI documents. An empty literal-source cell can also arise from nested route declarations. All 857 listed method/path occurrences exist in the bundled API documents. This checks contract coverage. A passing user journey also requires a mounted handler, enabled feature, authorized session, working persistence and usable screen.

271 non-deferred entries reference a built screenshot. The other 25 comprise 15 proposed boards and 10 layout briefs. The screenshot records do not identify a tested Git revision. All six planned screens have route declarations in the PR. The export, PR body and route inventory provide insufficient evidence to certify every non-deferred screen or twelve end-to-end backend capabilities as shipped.

## Release claims

| Claim | Verified evidence |
|---|---|
| Console is the default | The server setting and browser defaults select Console on the PR. Existing preferences can select Classic. |
| Emergency rollback is platform-wide and instant | The API command is tenant-scoped and requires role-management authority. At the reviewed revision the Design D shell does not consume the emergency setting. PR 932 contains the cross-session repair, verified below. Per-browser persisted selection also means a remote change needs to reach the browser before it can take effect. |
| Merge automatically deploys production | Release admission and platform validation run on dev. The promotion workflow requires a successful platform run and release-gate evidence for its candidate revision. Both environment descriptors select the host target. This repo publishes the release revision for a host consumer. Successful host receipt, rollout and recovery require separate operational evidence. |
| Continuous Classic and Console parity | The scheduled and manually triggered live workflow exercises Chromium and Firefox suites. The release tests include explicitly marked Classic journeys. An assertion of full parity across every board would require an experience-by-journey coverage matrix. |
| Six wording changes are all that remains for counsel | The source annotations also ask for decisions that can change behavior. In p4 the exit-settlement date is one day apart under the two proposed counting rules. Another p4 entry leaves applicability and deadlines of workplace-closure filings open. The export establishes neither approval nor that each decision can be implemented by replacing one translated string. |
| Nine worktrees can be removed safely | Nine matching worktrees exist. The production-cutover worktree contains eight modified files at this snapshot. A clean worktree can still have unique commits, so reachability from the final merged history must be verified before removal. |

The hosted PR 930 run at this revision failed the web job, three UI-state shards and core browser journeys. The core job recorded a ten-minute Home benchmark timeout and a WebKit registration timeout. PR 931’s hosted web job also recorded a jump-palette timeout. A green local suite or an earlier run cannot establish release readiness for either revision. [PR 930 CI](https://github.com/oyatie/console-next/actions/runs/46095042337) · [PR 931 CI](https://github.com/oyatie/console-next/actions/runs/46098511014)

## Deferred implementation

The inventory enumerates all 77 deferred entries. The first implementation slice is the audit evidence register. It uses the existing tenant-scoped evidence list, detail, verification and hold operations. Six PostgreSQL runtime-role checks have passed for this slice, including digest mismatch, tenant isolation, cursor stability and distinct approvers on release. Browser qualification and PR integration are tracked separately from the design status recorded in the CSV.

## Follow-up evidence

- [Cutover fixes, PR 932](https://github.com/oyatie/console-next/pull/932) contains the tenant emergency rollback repair. A release-backend Chromium test used two independent passkey sessions. Both observed the override. An open draft survived activation, reloading retained Classic, and the authorized operator cleared the switch from Classic Settings. The saved personal Console choice returned without a reload. A fresh browser with no cached tenant state learns the setting at its first authenticated workspace read.
- [Evidence register, PR 933](https://github.com/oyatie/console-next/pull/933) implements the four evidence operations. Five Chromium and five Firefox journeys passed, alongside six database tests. All 409 tests in the eleven files flagged by the first broad local run passed when rerun with two workers and their original timeouts.
- [Payroll outlook, PR 934](https://github.com/oyatie/console-next/pull/934) at `258acc7a3e` forecasts from explicitly entered historical KRW totals. The default build omits analytics. The analytics-enabled build checks the caller’s KpiRead authority. Eight browser journeys and real API tests with both builds passed.
- The product disposition for regions retires standalone creation and renaming. The command validator enforces this decision before insertion, and legacy closure remains a compatibility operation. The board lists those actions as future work. A product decision is outstanding. [Product disposition at the reviewed revision](https://github.com/oyatie/console-next/blob/aa58f9ae0d60b5fdf5696ec5a66d5f056c5221fe/docs/product/capability-dispositions.md#organization-changes)

- The [deferred inventory](deferred.csv) records the results of dispatching each of the 363 listed HTTP operations to real compiled routers. The full build mounted all 363. The default build mounted seven, covering object lifecycle and legacy regions. A mounted write still requires appropriate authority and applicable state. The inventory identifies each method, build feature and product disposition.
- [Findings triage, PR 935](https://github.com/oyatie/console-next/pull/935) adds the deferred audit worklist. Two simultaneous PostgreSQL decisions previously both reported success. The repair records one decision and one audit event, and returns a conflict for the competing decision. The feature branch exercised 12 browser journeys.
- The cutover Home benchmark originally waited for ten minutes even with employee rows rendered. Three fresh measurements from the production build, with 2,000 imported employees, reached the first rendered rows in 351–664 ms against the existing 2,000 ms limit. The WebKit first-run journey now passes registration and checks the actual outcome of a closed filing on a compact screen.
- The Ops promotion board describes optional sign-off. The service at the reviewed head reports Watching with zero sign-offs and requires an affirmative verdict before reporting Ready. This release audit preserves the implemented requirement. Missing freeze samples could previously report Ready, and a direct request could generate a hand-off for a digest outside the preview. The service in [PR 932](https://github.com/oyatie/console-next/pull/932) checks the preview digest, release gates, operator feedback, sign-off and fresh freeze evidence before writing a hand-off. The regression tests cover empty, future, stale and invalid measurements, a mismatched digest and the absence of a receipt on refusal.
- The first hosted release-gate run on PR 932 refused four migration classifications. The declarations now identify the affected access, workflow, recovery and realtime behavior. The full migration-safety test suite passed locally with these changes.

- The Operator Cockpit now derives the image reference and bake class from the digest-matched release statement. The tested hand-off passed the production host script’s argument parser with a synthetic registry and digest. Its Chromium journey required a staging sign-off, then displayed the qualified receipt. Host signing, secret provisioning and execution still need independent deployment evidence.


## Verified follow-up work on 2026-11-28

| Surface | Verified result | Review |
|---|---|---|
| Dev directory performance | The previous Firefox mark could fire while the roster was hidden. The visibility-aware hosted check measured 2,072 ms against a 2,000 ms limit. The saved-draft journey also raced its receipt navigation. A delayed Firefox replay failed before the receipt change and passed afterward. | [PR 931](https://github.com/oyatie/console-next/pull/931) |
| Desk clock-out | The write handler now resolves the employee’s current attendance policy. The self endpoint reports that same decision to both experiences. A failed attendance read previously offered a clock-in action. PostgreSQL and HTTP tests cover default refusal, inheritance, a person override and command replay. | [PR 932](https://github.com/oyatie/console-next/pull/932) |
| Team and dispatch | The direct team uses the linked organizational unit ID. Counts and contract end dates use the scoped query before pagination. Dispatch links open the addressed offer. | [PR 936](https://github.com/oyatie/console-next/pull/936) |
| Pay group membership | A later hire prevented a two-group payroll preview. A dated assignment now makes the hire payable. A separate test reproduced retroactive reassignment of an employee already present on a closed, historical sole-group roster. The repaired command refuses the reassignment. | [PR 938](https://github.com/oyatie/console-next/pull/938) |
| Personnel request links | A link to a request outside the first 20 rows silently lost the selected record. Both experiences now query that ID under the existing server access rules. PostgreSQL and browser tests cover unavailable records and recovery after a failed read. | [PR 939](https://github.com/oyatie/console-next/pull/939) |

Five deferred entries have implementations in review. Their PRs cover the evidence register, findings, lifecycle detail, location-consent history, and payroll outlook. The CSV retains all 77 entries and separates the original design disposition from subsequent implementation evidence. [Deferred inventory](deferred.csv)
