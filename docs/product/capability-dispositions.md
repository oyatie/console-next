<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# MVP capability dispositions

This is the product disposition source for hidden and partially exposed operations in identity, organization changes, attendance and payroll. Operations are identified by their OpenAPI method and path; crate ownership does not necessarily match the navigation module (organization changes also owns personnel APIs).

The measured column is the audit snapshot at `53883de8170c552ea05cc82438d7a56bb38f115b`: identity 70, organization changes 41, attendance 14 and payroll 13 operations. Delivery can improve exposure without changing an operation's product disposition.

`expose` names the intended route and component, including planned components. It is a delivery requirement, not a claim that the operation is reachable today. `allow-list` refers to the exact operation entry in [the capability allow-list](../../scripts/reach-baseline.json): that entry supplies the accountable owner, reason and release gate. No allowance is added or extended here. `internal` means application plumbing or an obsolete protocol rather than a user action. These decisions do not change measured exposure.

Partially exposed operations keep their current route and component; their refusal messages must be translated in both Korean and English through the shared refusal renderer. Dedicated region and branch draft commands remain an explicit delivery requirement rather than being replaced with generic organization change creation.

## identity

| Operation | Measured | Disposition | Destination or reason |
| --- | --- | --- | --- |
| `GET /api/platform/groups` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/platform/groups` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `PATCH /api/platform/groups/{id}` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/platform/groups/{id}/accounts` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/platform/groups/{id}/accounts` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `DELETE /api/platform/groups/{id}/accounts/{user_id}/roles/{group_role}` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `PUT /api/platform/groups/{id}/organizations/{org_id}` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `DELETE /api/platform/groups/{id}/organizations/{org_id}` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `PATCH /api/platform/orgs/{id}` | partial | expose | `/platform` · `Tenants`; complete refusal recovery copy. |
| `DELETE /api/platform/orgs/{id}` | partial | expose | `/platform` · `Tenants`; complete refusal recovery copy. |
| `POST /api/platform/orgs/{id}/admin-otp` | partial | expose | `/platform` · `Tenants`; complete refusal recovery copy. |
| `GET /api/platform/support-sessions` | hidden | expose | `/platform` · `SupportSessions`; Support session review and start/end controls belong in platform administration. |
| `POST /api/platform/support-sessions` | hidden | expose | `/platform` · `SupportSessions`; Support session review and start/end controls belong in platform administration. |
| `POST /api/platform/support-sessions/{id}/approve` | hidden | expose | `/platform` · `SupportSessions`; Support session review and start/end controls belong in platform administration. |
| `POST /api/platform/support-sessions/{id}/end` | hidden | expose | `/platform` · `SupportSessions`; Support session review and start/end controls belong in platform administration. |
| `POST /api/platform/support-sessions/{id}/start` | hidden | expose | `/platform` · `SupportSessions`; Support session review and start/end controls belong in platform administration. |
| `GET /api/v1/access/ops-usage` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/access/requests` | partial | expose | `/access/grants` · `AccessRequests`; complete refusal recovery copy. |
| `POST /api/v1/access/requests/{requestId}/close` | partial | expose | `/access/grants` · `AccessRequests`; complete refusal recovery copy. |
| `DELETE /api/v1/access/roles/{roleId}` | partial | expose | `/access/roles` · `RolesPage`; complete refusal recovery copy. |
| `POST /api/v1/access/roles/{roleId}/status` | partial | expose | `/access/roles` · `RolesPage`; complete refusal recovery copy. |
| `POST /api/v1/auth/device-login/approve` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/auth/device-login/approve-session` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/auth/device-login/poll` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/auth/device-login/start` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/auth/passkey/enroll-handoff` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/auth/signup` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/branches` | hidden | expose | `/org?tab=changes` · `RegionBranchDraft`; Draft branch changes through the dedicated commands and review the resulting organization change. |
| `GET /api/v1/branches/{id}` | hidden | expose | `/org?tab=changes` · `RegionBranchDraft`; Draft branch changes through the dedicated commands and review the resulting organization change. |
| `PATCH /api/v1/branches/{id}` | hidden | expose | `/org?tab=changes` · `RegionBranchDraft`; Draft branch changes through the dedicated commands and review the resulting organization change. |
| `DELETE /api/v1/branches/{id}` | hidden | expose | `/org?tab=changes` · `RegionBranchDraft`; Draft branch changes through the dedicated commands and review the resulting organization change. |
| `POST /api/v1/console/kill-switch` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/console/rollout` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `PUT /api/v1/console/rollout/opt-in` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `PUT /api/v1/console/rollout/org-flag` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/console/telemetry/route` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/group-admin/groups` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/group-admin/tenant-context` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/group-admin/tenant-context/exit` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/me/workbench` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/me/workspace` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `PUT /api/v1/me/workspace` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/policy/assignments` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/policy/audit-events` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/policy/authorize` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/policy/authorize/bulk` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/policy/catalog` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/policy/decisions` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/policy/drafts` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/policy/drafts` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/policy/drafts/{draft_id}` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `PUT /api/v1/policy/drafts/{draft_id}` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/policy/drafts/{draft_id}/review` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/policy/drafts/{draft_id}/submit` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/policy/drafts/{draft_id}/validate` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/policy/features` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/policy/role-templates` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/policy/roles` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/policy/roles` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `PATCH /api/v1/policy/roles/{id}` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `PATCH /api/v1/policy/roles/{id}/status` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/policy/roles/{id}/status-preview` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/policy/simulate` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/policy/users/{id}/assignment-preview` | hidden | expose | `/access/people/$accountId` · `PersonAccessPage`; Preview the policy assignment before committing it. |
| `PUT /api/v1/policy/users/{id}/assignments` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/regions` | hidden | expose | `/org?tab=changes` · `RegionBranchDraft`; Draft region changes through the dedicated commands and review the resulting organization change. |
| `PATCH /api/v1/regions/{id}` | hidden | expose | `/org?tab=changes` · `RegionBranchDraft`; Draft region changes through the dedicated commands and review the resulting organization change. |
| `DELETE /api/v1/regions/{id}` | hidden | expose | `/org?tab=changes` · `RegionBranchDraft`; Draft region changes through the dedicated commands and review the resulting organization change. |
| `GET /api/v1/release-toggles` | hidden | internal | Release configuration read by application plumbing; no standalone user command. |
| `PATCH /api/v1/users/{id}` | partial | expose | `/people/$id` · `EmployeeCard`; complete refusal recovery copy. |

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
| `PUT /api/v1/employees/{id}/home-branch` | hidden | expose | `/people/$id` · `SecJob`; Review and correct the employee’s home branch through the personnel card. |
| `GET /api/v1/employees/{id}/onboarding-checklist` | hidden | expose | `/people/$id` · `CardSpine`; Show the employee’s remaining onboarding work on the personnel card. |
| `POST /api/v1/employees/{id}/photo-uploads/{upload_id}/confirm` | partial | expose | `/people/$id` · `EmployeeCard`; complete refusal recovery copy. |
| `GET /api/v1/employees/{id}/records` | partial | expose | `/people/$id` · `EmployeeCard`; complete refusal recovery copy. |
| `POST /api/v1/employees/{id}/records/{section}` | partial | expose | `/people/$id` · `EmployeeCard`; complete refusal recovery copy. |
| `PUT /api/v1/employees/{id}/records/{section}/{entry_id}` | partial | expose | `/people/$id` · `EmployeeCard`; complete refusal recovery copy. |
| `POST /api/v1/employees/{id}/rehire` | partial | expose | `/people/$id` · `EmployeeCard`; complete refusal recovery copy. |
| `GET /api/v1/hr/absence-exit-dashboard` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/hr/attendance-import/preview` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/hr/attendance-import/summary` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/hr/attendance-import/{run_id}/apply` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/hr/attendance-import/{run_id}/dry-run` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/hr/attendance-records` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/hr/attendance-records/me` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/hr/attendance-records/me` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
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
| `POST /api/v1/attendance/closes` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/attendance/closes/preflight` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/attendance/closes/{close_id}/amendments` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/attendance/exceptions` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/attendance/exceptions/{exception_id}` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/attendance/exceptions/{exception_id}/resolve` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/attendance/me/exceptions` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/attendance/me/schedule` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/attendance/me/week52` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/attendance/substitution-candidates` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/attendance/substitutions` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/attendance/substitutions` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/attendance/substitutions/{substitution_id}/cancel` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/attendance/week52/acks` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |

## payroll

| Operation | Measured | Disposition | Destination or reason |
| --- | --- | --- | --- |
| `GET /api/v1/payroll/payslips/me` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/payroll/runs/{id}/calculate` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/payroll/runs/{id}/close-attendance` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/payroll/runs/{id}/close-preflight` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/payroll/runs/{id}/decision` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/payroll/runs/{id}/disbursement/attest` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/payroll/runs/{id}/exceptions` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/payroll/runs/{id}/exceptions/{exceptionId}/resolve` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/payroll/runs/{id}/issue-payslips` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `GET /api/v1/payroll/runs/{id}/payslip-delivery` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/payroll/runs/{id}/schedule-disbursement` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/payroll/runs/{id}/submit` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
| `POST /api/v1/payroll/runs/{id}/withdraw` | hidden | allow-list | Existing operation entry in `scripts/reach-baseline.json` (owner, reason and release gate). |
