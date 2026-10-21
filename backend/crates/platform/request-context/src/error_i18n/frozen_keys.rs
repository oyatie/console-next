//! OD-8 freeze: every English key of the error_i18n tables at the R2 step 0
//! move, one per line under its table name. Lines may only be added.

pub(super) const FROZEN_KEYS: &str = r#"
[MESSAGES]
Idempotency-Key header is required
Idempotency-Key must be 16..200 characters
idempotency key was reused with a different request
idempotency key already used with a different employee payload
employee number or idempotency key is already in use
missing or malformed bearer token
invalid bearer token
token tier is not valid for this route
enroll a passkey before performing this action
enroll a passkey before creating tenants
invalid or expired one-time code
resetting credentials requires a step-up assertion of your passkey
removing a passkey requires a step-up assertion of your passkey
reissuing a tenant admin code requires a step-up assertion of your passkey
passkey step-up failed
passkey sign-in failed
passkey ceremony failed
issuing a sign-in code requires a step-up assertion of your passkey
adding a passkey requires a step-up assertion of an existing passkey
minting an enrollment handoff requires a step-up assertion of an existing passkey
deactivating an account requires a fresh passkey step-up
creating a group account requires a step-up assertion of your passkey
assigning an organization to a group requires a step-up assertion of your passkey
force-removing a tenant requires a step-up assertion of your passkey
enroll a passkey before reissuing tenant admin codes
passkey step-up is not configured for the platform API
passkey step-up is not configured for identity API
branch_id is required for a branch-scoped user
too many requests; please retry later
role is not allowed to use feature
resource branch is outside principal scope
principal has no branch scope
feature is unavailable in v1
not allowed to manage users in that branch
not allowed to change elevated roles
request references an unknown region or branch
user not found
direct region/branch mutation is disabled; submit an OrgProposal instead
role is not allowed to read org changes
role is not allowed to draft org changes
role is not allowed to approve org changes
role is not allowed to apply org changes
token is not authorized for org changes
org-change request was not found
superseded org-change request was not found
only a REJECTED request can be superseded by a revision
effectiveDate must be today or later (KST)
only a DRAFT or PRECHECKED request can be edited
preflight runs only on a DRAFT or PRECHECKED request
submit requires a DRAFT or PRECHECKED request
preflight blockers are present; resolve them and re-run preflight
approval decisions apply only while the request is IN_APPROVAL
approval step is already decided
approval step was not found
approval steps must be decided in order
only an APPROVED request can be effectuated
only a SETTLING request can be archived
settlement items complete only while the request is SETTLING
settlement item is already complete
settlement item was not found
unsettled items remain; complete every settlement item first
illegal org-change status transition
legacy org-setup proposals must contain exactly one operation
legacy org-setup proposals only accept region or branch operations
name and/or parentId is required
MOVE_ORG_UNIT parentId must differ from orgUnitId
REASSIGN_ORG_UNIT source and target must differ
REASSIGN_ORG_UNIT fromOrgUnit/toOrgUnit must be OrgUnit UUIDs
RENAME_BRANCH requires a name and/or a target region
target.ref must be a UUID for REGION/BRANCH/SITE targets
org unit was not found
org unit was not found in this organization
org unit is not active
parent org unit is not active
org unit kind cannot nest under that parent
active child org units remain
employees (on leave included) remain in the org unit
active branches remain under the region
active users are still assigned to the branch
non-terminal equipment remains in the branch
region was not found
region not found
region is already deactivated
branch was not found
branch not found
branch is already deactivated
site was not found
unknown status filter
unknown kind filter
request body is not canonical
org_unit_id is required
org_unit_id must be an ACTIVE site, department, or team
employee not found
employee was not found in this organization
comment is required
effective_date is required
date must use YYYY-MM-DD
event_type must be ONBOARD, TRANSFER, PROMOTE, LEAVE_OF_ABSENCE, RETURN_FROM_LEAVE, or CONTRACT_RENEWAL
to_status must be ACTIVE, ON_LEAVE, or UNKNOWN
to_position is required for PROMOTE
expected_return_date is only allowed for LEAVE_OF_ABSENCE
contract_end_date is required for CONTRACT_RENEWAL
contract_end_date is only allowed for CONTRACT_RENEWAL
expected_return_date must be on or after effective_date
contract_end_date must be on or after effective_date
employee is already EXITED; no lifecycle events are allowed
employee is ON_LEAVE; record RETURN_FROM_LEAVE first
ONBOARD must result in ACTIVE status
OFFBOARD and TERMINATE must result in EXITED status
OFFBOARD and TERMINATE are recorded by confirming an exit case
TRANSFER must keep the employee ACTIVE
PROMOTE must keep the employee ACTIVE
LEAVE_OF_ABSENCE requires an ACTIVE employee
LEAVE_OF_ABSENCE must result in ON_LEAVE status
RETURN_FROM_LEAVE requires an ON_LEAVE employee
RETURN_FROM_LEAVE must result in ACTIVE status
CONTRACT_RENEWAL requires a CONTRACT employment
CONTRACT_RENEWAL must keep the current status
ONBOARD cannot be scheduled; effective_date must not be in the future (KST)
lifecycle event not found
only a SCHEDULED lifecycle event can be cancelled
a scheduled exit is withdrawn by cancelling or rejecting its exit case
employee already has a scheduled exit; no exit case can be reported
the exit has not taken effect; submit the settlement once the employee has exited
reason must be 1000 characters or fewer
leave_type is only allowed for LEAVE_OF_ABSENCE
leave_type must be CHILDCARE, MATERNITY, ILLNESS, PERSONAL, or OTHER
hire_date is required
hire_date must not be in the future (KST)
contract_end_date is required for CONTRACT employment
contract_start_date and contract_end_date are only allowed for CONTRACT employment
contract_end_date must be on or after contract_start_date
status must be ACTIVE, ON_LEAVE, EXITED, or UNKNOWN
bulk event_type must be TRANSFER or PROMOTE
to_org_unit_id is required for TRANSFER
to_position is only allowed for PROMOTE
to_org_unit_id is only allowed for TRANSFER
employee_ids must list 1 to 500 employees
employee_ids must not repeat an employee
tenant was not found
tenant is not active
tenant has no active SUPER_ADMIN account
tenant admin account is not active
tenant admin has already enrolled a passkey
enroll a passkey before reissuing tenant admin codes
reason must not be blank
reason must be at most 1000 characters
exit case not found
exit approval draft requires HQ confirmation first
HR confirmation requires a REPORTED exit case
only an open exit case (REPORTED through APPROVAL_DRAFTED) can be rejected
only a REPORTED or HR_CONFIRMED exit case can be cancelled
cancelling an exit case requires the reporter or HR confirmation capability
reason is required
employee is already EXITED; no exit case can be reported
employee is no longer EXITED; the exit cannot be reversed
exit settlement requires complete wage source fields before approval draft
HQ confirmation must be performed by a different actor than the HR confirmer
HQ confirmation requires a prior HR confirmation
HQ confirmation requires a recorded HR confirmer
HQ confirmation requires the exit-case HQ confirmation capability
HR confirmation requires the exit-case HR confirmation capability
rejecting an exit case requires an exit-case confirmation capability
absence alert not found for employee
employee or absence alert was not found in the requested branch
[CODES]
validation
bad_request
lifecycle_schedule_conflict
lifecycle_scheduled_state
not_found
forbidden
conflict
preflight_blocked
lifecycle_noop
bulk_lifecycle_refused
admin_already_enrolled
invalid_transition
unauthorized
passkey_required
lifecycle_signoff_required
too_many_requests
internal
unavailable
out_of_scope
scope_tenant_wide_only
scope_node_closed
access_request_note_required
access_request_not_found
access_request_closed
ops_recovery_no_second_operator
ops_recovery_not_enrolled
ops_recovery_already_open
ops_recovery_sod_requester
ops_recovery_shared_authenticator
ops_recovery_not_approved
ops_recovery_hold_active
ops_recovery_cancelled
ops_recovery_evidence_identifier
[STATUS_LABELS]
ACTIVE
ON_LEAVE
EXITED
UNKNOWN
[EVENT_LABELS]
TRANSFER
PROMOTE
LEAVE_OF_ABSENCE
RETURN_FROM_LEAVE
CONTRACT_RENEWAL
TERMINATE
[SIGNOFF_LABELS]
privacy_notice_ack
korean_labor_law_ack
payroll_cutoff_ack
retirement_settlement_ack
"#;
