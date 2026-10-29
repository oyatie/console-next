<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Tenant-approved support access

Support access gives a vendor operator temporary, read-only access to a tenant's explicitly approved scope. It requires two distinct operators with device-bound assertions, tenant consent through the `support_access::approve` permission, and a live support-session ledger. It creates no standing tenant account or fallback tenant role. A deployment with no eligible second operator refuses with `support.refuse.no_second_operator`; one with no tenant approver refuses with `support.refuse.no_tenant_approver`.

## Grant, end and review access

1. The requesting operator submits a ticket reference, reason code, reason, reviewed read scope and requested duration through `/api/platform/support-sessions`, using a bound step-up assertion.
2. A distinct eligible operator supplies a separate bound assertion to approve the request at `/api/platform/support-sessions/{id}/approve`. The requester cannot approve their own request.
3. A tenant holder of `support_access::approve` reviews the operator, ticket, reason, scope and request deadline at `/audit/support-access`. They may deny the request or approve a positive duration no longer than the requested duration and the tenant's configured maximum. Personal-field disclosure requires an explicit grant of the `personal` class.
4. After both approvals, the requesting operator starts the session through `/api/platform/support-sessions/{id}/start`, using a bound step-up assertion. Approval alone does not start access. An approved but unstarted request still expires at its request deadline.
5. The tenant can withdraw consent before start or end active access from the same page through `/api/v1/support-sessions/{id}/end`. Operators can end access through `/api/platform/support-sessions/{id}/end`. Ended, revoked, denied and expired sessions cannot be reactivated by an end action.

Tenant history includes decisions, actor labels, read methods, paths and times. Requests and decisions belong to the target tenant under forced row-level security. Vendor lists project opaque identifiers, state and times only; tenant content, ticket details and stated reasons do not cross into that list.

The support notice and history update through the existing server-sent event stream. Idle support reads render no banner or empty landmark; pending and active notices keep all operator rows and actions in the page flow. Active-session details show the support deadline rather than the earlier request deadline. Durations are entered in minutes and displayed with locale-formatted hours and minutes.

`/api/v1/support-sessions/active` is the shared visibility projection for navigation and pending notifications. It returns pending requests only to approval holders, including the deadline and a request-specific deep link. Approval work also appears through `/api/v1/me/action-inbox` with kind `support_access`, target `support_session` and destination `/audit/support-access?review=<id>`. This source uses the decision endpoint's permission resolver, confines rows to the tenant and excludes expired or decided requests. Decisions and end actions remain on the support-access page.

Operators use the current platform surface. Tenant sessions opening `/platform*` receive the Korean 404 page. A separate operator origin and application are not part of this surface.

## Read scope and masking

The authz loader `cedar_pbac::visible::load_support_session` reads the current session under tenant RLS. The read boundary and downstream feature checks use that snapshot for scope, approval, expiry and reveal facts. Cedar refuses mutation methods with `support.refuse.read_only`, and scope is checked again after the handler. Support principals carry an empty legacy branch scope.

Only reviewed rows in `support_read_surfaces` permit content reads. Unknown routes, write methods and ungranted field classes fail closed. Reviewed API-field classifications follow the personal-data registry rather than matching database column names. Personal fields are masked by default; a tenant can explicitly grant the personal class. Sensitive and unknown fields remain masked.

| Surface | Readable within the granted domain | Protected without a personal grant |
| --- | --- | --- |
| `/api/v1/org-units` | Identity, kind, name, parent, status, effective date, update time and headcount | Head name and employee reference |
| `/api/v1/org-structure` | Tenant name, phase, snapshot date, organization names, counts and status | Head identity and individual assignment facts |
| `/api/v1/legal-entities` | Entity identity, business state, registration facts and counts | Representatives, directors, co-owners and named reviews |
| `/api/v1/workplaces` | Workplace identity, name, kind, business state and counts | Representative name, contact email and mobile |
| `/api/v1/employees` | Pagination totals and the registry's structural organization-unit identifier | Individual facts, including name, contacts and employment facts |

Every returned leaf is classified in the response registry, defined by `20261023100100000_support_response_classes.sql`. Reviewed containers allow traversal; unknown containers stay masked even if they contain familiar names. Dotted response paths protect nested personal names separately from organization names. Protected JSON columns are masked as a whole, including their object keys. Scope review and field aliases belong in reference data.

## Duration, revocation and audit

`support.request_expiry` and `support.max_duration` are settings-registry keys with vendor defaults. Tenant overrides resolve through the shared settings store. Registry ranges cap both values at their vendor defaults, so a tenant can only tighten them. The API and database reject settings above those caps.

The approved duration determines the active-session deadline and token expiry. Operator family logout, revocation, authority changes and tenant suspension invalidate reads immediately. Deadline checks apply on reads without waiting for the expiry worker.

Every support-token request appends `support.access` to the target tenant's existing audit chain before its response leaves. Revocation is checked again after the handler and at audit commit. Failed audit writes withhold the response. Audit identities carry the operator display name and operator organization; opaque references remain stored separately.

## Declared API compatibility changes

- Removed `POST /api/platform/view-as`, `/api/platform/view-as/exit`, `/api/platform/tenant-context`, and `/api/platform/tenant-context/exit`. Existing vendor impersonation tokens no longer resolve as tenant principals. The separate tenant-owned group-admin context remains supported.
- A platform token presented to a tenant route receives **401** rather than 403. Support refusals use RFC 9457 problem details with stable `support.refuse.*` codes and retain the shared `error.code` envelope for current clients.
- The access catalog adds the `support_access` domain with its approval permission.
- Operator clients use the typed `supportSessionsApi` client and `/api/platform/support-sessions`; tenant clients use `/api/v1/support-sessions`. The published contract and generated client types replace the deleted endpoints.
- Response domains and action-inbox kinds are extensible; access-role commands retain the strict catalog vocabulary. See the [per-class N-1 compatibility decisions](release-api-compat-2.md).
