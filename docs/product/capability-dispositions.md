<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# MVP capability dispositions

This is the product disposition source for hidden and partially exposed operations in identity, organization changes, attendance and payroll. Operations are identified by their OpenAPI method and path; crate ownership does not necessarily match the navigation module (organization changes also owns personnel APIs).

The measured column is the audit snapshot at `53883de8170c552ea05cc82438d7a56bb38f115b`: identity 70, organization changes 41, attendance 14 and payroll 13 operations. Delivery can improve exposure without changing an operation's product disposition.

`expose` names the intended route and component, for operations with a product call site. Hidden operations require an owned allowance until delivery. `allow-list` refers to the exact operation entry in [the capability allow-list](../../scripts/reach-baseline.json): its `operations` entries cover missing calls, and entries with `scope: route` cover dormant wrappers without a screen. Each supplies the accountable owner, reason and release gate. `internal` means application plumbing or an obsolete protocol rather than a user action. These decisions do not change measured exposure. `check-reach.mjs` validates this table against the contract and allowances, requires classifications for uncalled operations in these modules, and ratchets capability allowances after their initial inventory.

System endpoints discovered by the gate are listed as internal below the original audit snapshot.

Partially exposed operations keep their current route and component; their refusal messages must be translated in both Korean and English through the shared refusal renderer. Separate region and branch creation and renaming are retired by the workplace model; legacy closure remains a compatibility operation and existing protocol URLs do not justify duplicate organization controls. Their allowances remain until compatibility retirement. Other undelivered operations retain an MVP release gate and an accountable product owner.

## identity

| Operation | Measured | Disposition | Destination or reason |
| --- | --- | --- | --- |
| `POST /api/v1/users/me/employee-link/prepare` | exposed | expose | `/people/$id` · `SelfAccountLink` asks Cedar whether an own-account link is available. |
| `POST /api/v1/users/me/employee-link` | exposed | expose | `/people/$id` · `SelfAccountLink` submits the command-bound passkey assertion. |
| `POST /api/v1/users/me/employee-link/withdraw` | exposed | expose | `/people/$id` · `SelfAccountLink` withdraws its unreviewed receipt with a fresh passkey. |
| `POST /api/v1/users/employee-link-attestations/{id}/review` | exposed | expose | `/inbox` · `SelfBindingReview` confirms or revokes an independently reviewed account link with a fresh passkey. |
| `GET /api/platform/groups` | hidden | internal | Vendor-tier group operation wrapped by `packages/api/src/platform-groups.ts` outside tenant screens. |
| `POST /api/platform/groups` | hidden | internal | Vendor-tier group operation wrapped by `packages/api/src/platform-groups.ts` outside tenant screens. |
| `PATCH /api/platform/groups/{id}` | hidden | internal | Vendor-tier group operation wrapped by `packages/api/src/platform-groups.ts` outside tenant screens. |
| `GET /api/platform/groups/{id}/accounts` | hidden | internal | Vendor-tier group operation wrapped by `packages/api/src/platform-groups.ts` outside tenant screens. |
| `POST /api/platform/groups/{id}/accounts` | hidden | internal | Vendor-tier group operation wrapped by `packages/api/src/platform-groups.ts` outside tenant screens. |
| `DELETE /api/platform/groups/{id}/accounts/{user_id}/roles/{group_role}` | hidden | internal | Vendor-tier group operation wrapped by `packages/api/src/platform-groups.ts` outside tenant screens. |
| `PUT /api/platform/groups/{id}/organizations/{org_id}` | hidden | internal | Vendor-tier group operation wrapped by `packages/api/src/platform-groups.ts` outside tenant screens. |
| `DELETE /api/platform/groups/{id}/organizations/{org_id}` | hidden | internal | Vendor-tier group operation wrapped by `packages/api/src/platform-groups.ts` outside tenant screens. |
| `PATCH /api/platform/orgs/{id}` | partial | expose | `/platform` · `Tenants`; complete refusal recovery copy. |
| `DELETE /api/platform/orgs/{id}` | partial | expose | `/platform` · `Tenants`; complete refusal recovery copy. |
| `POST /api/platform/orgs/{id}/admin-otp` | partial | expose | `/platform` · `Tenants`; complete refusal recovery copy. |
| `GET /api/platform/support-sessions` | hidden | allow-list | Platform administration: The tenant support-consent screen is not the platform session console. Deliver audited session review and lifecycle controls in platform administration before MVP release. Release gate: mvp. |
| `POST /api/platform/support-sessions` | hidden | allow-list | Platform administration: The tenant support-consent screen is not the platform session console. Deliver audited session review and lifecycle controls in platform administration before MVP release. Release gate: mvp. |
| `POST /api/platform/support-sessions/{id}/approve` | hidden | allow-list | Platform administration: The tenant support-consent screen is not the platform session console. Deliver audited session review and lifecycle controls in platform administration before MVP release. Release gate: mvp. |
| `POST /api/platform/support-sessions/{id}/end` | hidden | allow-list | Platform administration: The tenant support-consent screen is not the platform session console. Deliver audited session review and lifecycle controls in platform administration before MVP release. Release gate: mvp. |
| `POST /api/platform/support-sessions/{id}/start` | hidden | allow-list | Platform administration: The tenant support-consent screen is not the platform session console. Deliver audited session review and lifecycle controls in platform administration before MVP release. Release gate: mvp. |
| `GET /api/v1/access/ops-usage` | exposed | expose | `/access/people/$accountId` · `OpsUsageCard` renders the emergency access usage log (omitted on 403). |
| `POST /api/v1/access/requests` | partial | expose | `/access/grants` · `AccessRequests`; complete refusal recovery copy. |
| `POST /api/v1/access/requests/{requestId}/close` | partial | expose | `/access/grants` · `AccessRequests`; complete refusal recovery copy. |
| `DELETE /api/v1/access/roles/{roleId}` | partial | expose | `/access/roles` · `RolesPage`; complete refusal recovery copy. |
| `POST /api/v1/access/roles/{roleId}/status` | partial | expose | `/access/roles` · `RolesPage`; complete refusal recovery copy. |
| `POST /api/v1/auth/device-login/approve` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/auth/device-login/approve-session` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/auth/device-login/poll` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/auth/device-login/start` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/auth/passkey/enroll-handoff` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/branches` | hidden | allow-list | Organization structure: Only legacy region and branch closures remain supported. These pre-workplace cleanup commands stay outside the primary organization editor until place-model compatibility retirement. Release gate: place-model compatibility retirement. |
| `GET /api/v1/branches/{id}` | hidden | allow-list | Organization structure: Only legacy region and branch closures remain supported. These pre-workplace cleanup commands stay outside the primary organization editor until place-model compatibility retirement. Release gate: place-model compatibility retirement. |
| `PATCH /api/v1/branches/{id}` | hidden | allow-list | Organization structure: Separate branch and region drafting is retired under the workplace model. Workplace changes own placement; retain these protocol URLs until compatibility retirement. Release gate: place-model compatibility retirement. |
| `DELETE /api/v1/branches/{id}` | hidden | allow-list | Organization structure: Separate branch and region drafting is retired under the workplace model. Workplace changes own placement; retain these protocol URLs until compatibility retirement. Release gate: place-model compatibility retirement. |
| `POST /api/v1/console/kill-switch` | exposed | expose | `/settings?section=rollout` · `RolloutPanel` activates or clears emergency Classic fallback with audit note. |
| `GET /api/v1/console/rollout` | exposed | expose | `/settings?section=rollout` · `RolloutPanel` reads tenant rollout flag, personal opt-in, and emergency fallback state. |
| `PUT /api/v1/console/rollout/opt-in` | exposed | expose | `/settings?section=rollout` · `RolloutPanel` updates personal Console rollout opt-in. |
| `PUT /api/v1/console/rollout/org-flag` | exposed | expose | `/settings?section=rollout` · `RolloutPanel` updates tenant Console rollout flag with audit note. |
| `POST /api/v1/console/telemetry/route` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/group-admin/groups` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/group-admin/tenant-context` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/group-admin/tenant-context/exit` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/me/workbench` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/me/workspace` | exposed | expose | `/account` · `ExperienceChooser` reads the signed-in user's workspace preferences, including personal screen style override. |
| `PUT /api/v1/me/workspace` | exposed | expose | `/account` · `ExperienceChooser` persists the signed-in user's personal screen style override without clobbering other workspace layout keys. |
| `GET /api/v1/policy/assignments` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/policy/audit-events` | exposed | expose | `/access/policies` · `PoliciesPage` displays policy governance audit events. |
| `POST /api/v1/policy/authorize` | exposed | expose | `/access/check` · `AccessCheckPage` runs interactive point authorization checks. |
| `POST /api/v1/policy/authorize/bulk` | exposed | expose | `/access/check` · `AccessCheckPage` runs standard multi-action authorization matrix checks. |
| `GET /api/v1/policy/catalog` | exposed | expose | `/access/policies` · `PoliciesPage` lists Cedar policy catalog entries. |
| `GET /api/v1/policy/decisions` | exposed | expose | `/access/policies` · `PoliciesPage` displays recorded Cedar authorization decisions. |
| `GET /api/v1/policy/drafts` | exposed | expose | `/access/policies` · `PoliciesPage` lists no-code Cedar policy drafts. |
| `POST /api/v1/policy/drafts` | exposed | expose | `/access/policies` · `PoliciesPage` creates a new Cedar policy draft. |
| `GET /api/v1/policy/drafts/{draft_id}` | exposed | expose | `/access/policies/$draftId` · `PolicyDraftPage` loads a Cedar policy draft for editing and review. |
| `PUT /api/v1/policy/drafts/{draft_id}` | exposed | expose | `/access/policies/$draftId` · `PolicyDraftPage` updates a Cedar policy draft's no-code blocks. |
| `POST /api/v1/policy/drafts/{draft_id}/review` | exposed | expose | `/access/policies/$draftId` · `PolicyDraftPage` records four-eyes approve or reject review decisions. |
| `POST /api/v1/policy/drafts/{draft_id}/submit` | exposed | expose | `/access/policies/$draftId` · `PolicyDraftPage` submits a validated draft for four-eyes review. |
| `POST /api/v1/policy/drafts/{draft_id}/validate` | exposed | expose | `/access/policies/$draftId` · `PolicyDraftPage` validates Cedar draft syntax and schema rules. |
| `GET /api/v1/policy/features` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/policy/role-templates` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/policy/roles` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/policy/roles` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `PATCH /api/v1/policy/roles/{id}` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `PATCH /api/v1/policy/roles/{id}/status` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/policy/roles/{id}/status-preview` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/policy/simulate` | exposed | expose | `/access/policies/$draftId` · `PolicyDraftPage` runs Cedar draft sandbox simulations before submission. |
| `POST /api/v1/policy/users/{id}/assignment-preview` | hidden | allow-list | Access management: Policy preview has no rendered caller. Deliver assignment impact review on the person access screen before MVP release. Release gate: mvp. |
| `PUT /api/v1/policy/users/{id}/assignments` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/regions` | hidden | allow-list | Organization structure: Separate branch and region drafting is retired under the workplace model. Workplace changes own placement; retain these protocol URLs until compatibility retirement. Release gate: place-model compatibility retirement. |
| `PATCH /api/v1/regions/{id}` | hidden | allow-list | Organization structure: Separate branch and region drafting is retired under the workplace model. Workplace changes own placement; retain these protocol URLs until compatibility retirement. Release gate: place-model compatibility retirement. |
| `DELETE /api/v1/regions/{id}` | hidden | allow-list | Organization structure: Separate branch and region drafting is retired under the workplace model. Workplace changes own placement; retain these protocol URLs until compatibility retirement. Release gate: place-model compatibility retirement. |
| `GET /api/v1/release-toggles` | hidden | internal | Release configuration read by application plumbing; no standalone user command. |
| `PATCH /api/v1/users/{id}` | partial | expose | `/people/$id` · `EmployeeCard`; complete refusal recovery copy. |

| `GET /.well-known/apple-app-site-association` | hidden | internal | OS application association; no console screen. |
| `GET /.well-known/assetlinks.json` | hidden | internal | OS application association; no console screen. |
| `GET /api/v1/status/events` | hidden | internal | Unauthenticated public status feed; no signed-in console command. |
| `GET /api/v1/status/evidence` | hidden | internal | Unauthenticated public status evidence; no signed-in console command. |
| `GET /healthz` | hidden | internal | Process health probe used by deployment infrastructure. |
| `GET /readyz` | hidden | internal | Process readiness probe used by deployment infrastructure. |

## orgchange

| Operation | Measured | Disposition | Destination or reason |
| --- | --- | --- | --- |
| `GET /api/v1/change-sets` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/change-sets/{id}` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `DELETE /api/v1/change-sets/{id}` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/employee-records/{section}` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/employee-records/{section}/import/apply` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/employee-records/{section}/import/preview` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/employees/corrections/bulk/{id}` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/employees/import` | hidden | internal | Removed legacy importer returns 410; employee import uses preview, dry-run and apply. |
| `GET /api/v1/employees/import/{run_id}/reconcile` | partial | expose | `/people/import` · `ImportPage`; complete refusal recovery copy. |
| `PUT /api/v1/employees/import/{run_id}/reconcile/rows/{source_key}` | partial | expose | `/people/import` · `ImportPage`; complete refusal recovery copy. |
| `POST /api/v1/employees/lifecycle-events/bulk` | partial | expose | `/people/renew` · `RenewPage`; complete refusal recovery copy. |
| `GET /api/v1/employees/lifecycle-events/bulk/jobs/{job_id}` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/employees/register-facts/bulk` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `PATCH /api/v1/employees/{id}` | partial | expose | `/people/$id` · `EmployeeCard`; complete refusal recovery copy. |
| `PATCH /api/v1/employees/{id}/employment-facts` | partial | expose | `/people/$id` · `EmployeeCard`; complete refusal recovery copy. |
| `PUT /api/v1/employees/{id}/home-branch` | hidden | allow-list | Personnel placement: The contract marks this write as N-1 compatibility only; current consoles derive routing from effective placement. Retain the legacy URL until compatibility retirement instead of adding a second placement editor. Release gate: N-1 compatibility retirement. |
| `GET /api/v1/employees/{id}/onboarding-checklist` | hidden | allow-list | Personnel onboarding: The contract deprecates this legacy fact-derived checklist. Retain it for N-1 clients until compatibility retirement; remaining onboarding work belongs with the current personnel lifecycle surface. Release gate: N-1 compatibility retirement. |
| `POST /api/v1/employees/{id}/photo-uploads/{upload_id}/confirm` | partial | expose | `/people/$id` · `EmployeeCard`; complete refusal recovery copy. |
| `GET /api/v1/employees/{id}/records` | partial | expose | `/people/$id` · `EmployeeCard`; complete refusal recovery copy. |
| `POST /api/v1/employees/{id}/records/{section}` | partial | expose | `/people/$id` · `EmployeeCard`; complete refusal recovery copy. |
| `PUT /api/v1/employees/{id}/records/{section}/{entry_id}` | partial | expose | `/people/$id` · `EmployeeCard`; complete refusal recovery copy. |
| `POST /api/v1/employees/{id}/rehire` | partial | expose | `/people/$id` · `EmployeeCard`; complete refusal recovery copy. |
| `GET /api/v1/hr/absence-exit-dashboard` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/hr/attendance-import/preview` | exposed | expose | `/attendance?tab=import` · `ImportConsoleView` uploads spreadsheets for column preview. |
| `GET /api/v1/hr/attendance-import/summary` | exposed | expose | `/attendance?tab=import` · `ImportConsoleView` loads prior attendance import history. |
| `POST /api/v1/hr/attendance-import/{run_id}/apply` | exposed | expose | `/attendance?tab=import` · `ImportConsoleView` applies validated import runs with acknowledgement. |
| `POST /api/v1/hr/attendance-import/{run_id}/dry-run` | exposed | expose | `/attendance?tab=import` · `ImportConsoleView` runs dry-run validation and exception checks. |
| `GET /api/v1/hr/attendance-records` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/hr/attendance-records/me` | exposed | expose | `/me/attendance` · `MeAttendanceSections` displays the signed-in employee's clock records. |
| `POST /api/v1/hr/attendance-records/me` | exposed | expose | `/me/attendance` · `MeAttendanceSections` records clock-in and clock-out punches for the signed-in employee. |
| `GET /api/v1/hr/attendance-summary` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/hr/leave-balances` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/hr/minimum-wage` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/hr/org-chart` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/hr/readiness-summary` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/job-titles` | partial | expose | `/people/job-titles` · `JobTitlesPage`; complete refusal recovery copy. |
| `PATCH /api/v1/job-titles/{id}` | partial | expose | `/people/job-titles` · `JobTitlesPage`; complete refusal recovery copy. |
| `GET /api/v1/org-entities` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/org-units` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `PATCH /api/v1/org-units/{id}` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `DELETE /api/v1/org-units/{id}` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |

## attendance

| Operation | Measured | Disposition | Destination or reason |
| --- | --- | --- | --- |
| `POST /api/v1/attendance/closes` | exposed | expose | `/attendance?tab=close` · `CloseConsoleView` executes monthly attendance close. |
| `POST /api/v1/attendance/closes/preflight` | exposed | expose | `/attendance?tab=close` · `CloseConsoleView` evaluates preflight checks before closing. |
| `POST /api/v1/attendance/closes/{close_id}/amendments` | exposed | expose | `/attendance?tab=close` · `CloseConsoleView` files post-close amendments. |
| `POST /api/v1/attendance/exceptions` | exposed | expose | `/attendance?tab=issues` · `IssuesConsoleView` opens attendance exceptions from the board. |
| `GET /api/v1/attendance/exceptions/{exception_id}` | exposed | expose | `/attendance` · `IssuesConsoleView` loads attendance exception details and evidence in the side record pane. |
| `POST /api/v1/attendance/exceptions/{exception_id}/resolve` | exposed | expose | `/attendance?tab=issues` · `IssuesConsoleView` resolves open attendance exceptions. |
| `GET /api/v1/attendance/me/exceptions` | exposed | expose | `/me/attendance` · `MeAttendanceSections` displays the signed-in employee's attendance exceptions. |
| `GET /api/v1/attendance/me/schedule` | exposed | expose | `/leave` · `LeaveRequestPage` reads the signed-in employee's work schedule to count scheduled workdays across multi-day leave ranges. |
| `GET /api/v1/attendance/me/week52` | exposed | expose | `/me/attendance` · `MeAttendanceSections` displays the signed-in employee's weekly 52-hour projection. |
| `GET /api/v1/attendance/substitution-candidates` | exposed | expose | `/attendance?tab=day` · `SubstitutionsSheet` searches eligible shift substitution candidates. |
| `GET /api/v1/attendance/substitutions` | exposed | expose | `/attendance?tab=day` · `SubstitutionsSheet` lists scheduled shift substitutions. |
| `POST /api/v1/attendance/substitutions` | exposed | expose | `/attendance?tab=day` · `SubstitutionsSheet` records shift substitutions. |
| `POST /api/v1/attendance/substitutions/{substitution_id}/cancel` | exposed | expose | `/attendance?tab=day` · `SubstitutionsSheet` cancels scheduled substitutions. |
| `POST /api/v1/attendance/week52/acks` | exposed | expose | `/attendance?tab=overtime` · `OvertimeConsoleView` records 52-hour warning acknowledgements. |

## payroll

| Operation | Measured | Disposition | Destination or reason |
| --- | --- | --- | --- |
| `GET /api/v1/payroll/payslips/me` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/payroll/runs/{id}/calculate` | exposed | expose | `/payroll/runs/$id` · `RunConsole` triggers payroll run calculation. |
| `POST /api/v1/payroll/runs/{id}/close-attendance` | exposed | expose | `/payroll/runs/$id` · `RunConsole` snapshots attendance close into the payroll run. |
| `GET /api/v1/payroll/runs/{id}/close-preflight` | exposed | expose | `/payroll/runs/$id` · `RunConsole` loads attendance close preflight before calculation. |
| `POST /api/v1/payroll/runs/{id}/decision` | exposed | expose | `/payroll/runs/$id` · `RunConsole` records approve or return decisions on submitted runs. |
| `POST /api/v1/payroll/runs/{id}/disbursement/attest` | exposed | expose | `/payroll/runs/$id` · `RunConsole` attests payroll disbursement completion. |
| `GET /api/v1/payroll/runs/{id}/exceptions` | exposed | expose | `/payroll/runs/$id` · `RunConsole` lists open and carried payroll exceptions. |
| `POST /api/v1/payroll/runs/{id}/exceptions/{exceptionId}/resolve` | exposed | expose | `/payroll/runs/$id` · `RunConsole` resolves or acknowledges payroll exceptions. |
| `POST /api/v1/payroll/runs/{id}/issue-payslips` | exposed | expose | `/payroll/runs/$id` · `RunConsole` issues employee payslips for approved runs. |
| `GET /api/v1/payroll/runs/{id}/payslip-delivery` | exposed | expose | `/payroll/runs/$id` · `RunConsole` tracks payslip issuance and delivery status. |
| `POST /api/v1/payroll/runs/{id}/schedule-disbursement` | exposed | expose | `/payroll/runs/$id` · `RunConsole` schedules payroll disbursement dates. |
| `POST /api/v1/payroll/runs/{id}/submit` | exposed | expose | `/payroll/runs/$id` · `RunConsole` submits calculated payroll runs for approval. |
| `POST /api/v1/payroll/runs/{id}/withdraw` | exposed | expose | `/payroll/runs/$id` · `RunConsole` withdraws submitted payroll runs back to draft. |
