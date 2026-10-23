<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Tenant-approved support access — slice 1

OPS-SUPPORT-ACCESS-GATE is implemented by the support ledger, two distinct device-bound operator assertions, tenant `support_access::approve` permission, and the live read boundary. A deployment with no eligible second operator refuses with `support.refuse.no_second_operator`; one with no tenant approver refuses with `support.refuse.no_tenant_approver`.

The tenant page is `/audit/support-access`. The shell banner and history update through the existing SSE stream. `/support-sessions/active` is the shared Cedar-backed visibility projection for navigation, the pending notification and Home’s support approval `QueueSection`. It returns pending requests only to approval holders, including the deadline and a request-specific deep link. G2 must absorb `pendingApprovalQuery` and `features/home/ui/support-queue.tsx` into 업무함; the decision and end actions remain on this screen. Expired and already-decided requests leave the pending source.

Requests and decisions belong to the target tenant under forced RLS. Vendor lists project opaque identifiers, state and times only. Every support-token request appends `support.access` to that tenant's existing audit chain before its response leaves. Revocation is checked again after the handler and at audit commit. Failed audit writes withhold the response. Audit identities carry the operator display name and operator organization; opaque references remain stored separately.

Only reviewed rows in `support_read_surfaces` permit content reads. The initial reference data covers organization structure, organization units, legal entities, workplaces and the employee list. Unknown routes, write methods and ungranted field classes fail closed. Reviewed API-field classifications follow the personal-data registry rather than matching database column names. They mask personal fields by default; a tenant can explicitly grant the personal class. Sensitive and unknown fields remain masked. Every returned leaf is classified in the response registry. Reviewed containers allow traversal; unknown containers stay masked even if they contain familiar names. Dotted response paths protect nested personal names separately from organization names; protected JSON columns are masked as a whole, including their object keys. Scope review and field aliases belong in this reference data, never a fallback tenant role.

`support.request_expiry` and `support.max_duration` are settings-registry keys with vendor defaults. Tenant-scoped settings overrides resolve through the shared settings store. Registry ranges cap both values at their vendor defaults, so a tenant can only tighten the defaults. The API and database reject larger values. The approved support deadline controls token expiry; operator family logout, revocation, authority changes and tenant suspension still invalidate reads immediately.

## Declared API compatibility changes

- Removed `POST /api/platform/view-as`, `/api/platform/view-as/exit`, `/api/platform/tenant-context`, and `/api/platform/tenant-context/exit`. Existing vendor impersonation tokens no longer resolve as tenant principals. The separate tenant-owned group-admin context remains supported.
- A platform token presented to a tenant route now receives **401** rather than 403. Support refusals use RFC 9457 problem details with stable `support.refuse.*` codes and retain the shared `error.code` envelope for current clients.
- The access catalog adds the `support_access` domain with its approval permission.
- Operator clients use the typed `supportSessionsApi` client and `/api/platform/support-sessions`; tenant clients use `/api/v1/support-sessions`. The published contract and generated client types replace the deleted endpoints.

## Verification and hand-off

The fail-before worktree and logs are under `/Users/jasonlee/Developer/frontend/lanes/eco-g1-support`. They include missing-ledger RLS failure, missing Cedar support contract, missing tenant UI, old HTTP refusal behavior, WebSocket scope regression the approved-duration regression, read-validation problem details and withdrawal before start. Focused DB tests cover all support refusal codes, forced RLS, target-org audit identity, refusal before writes, audit failure, policy duration and immediate revocation. UI tests cover every refusal, history, consent commands, banner and the G2 query source.

The verifier runs `e2e/support-access.spec.ts` in Chromium: real bound WebAuthn assertions for two operators, tenant approval, banner, read, SSE history, tenant termination, next-call 401 and tenant `/platform*` 404. Its accessibility checks exercise 1440/390 in light/dark. Run first-run-solo and released-contract compatibility checks as part of the release verification. Full multi-browser E2E and mutations remain release-unit CI work.

Slice 2 is deferred to OC0-API/OC0-WEB. No ops origin/process migration or operator screen is included here. Proposed OC0-WEB paths remain `apps/ops/src/features/{tenants,support}/`. The current platform surface is retained for operators until that slice; tenant sessions opening `/platform*` receive the Korean 404.

## Recorded local proof (base `70de61dc`)

- Exact Rust CI: `cargo fmt --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, release-parity build/run of all 13 `console-gate-*` packages, and `cargo check --workspace --tests`: passed. The final status ledger is `ci-ready-status.json` in the lane evidence directory.
- Exact web command: 272 files / 1,816 tests passed, typecheck/lint/build passed, bundle 144.4 KB gzip against the 151 KB budget, and history/build gitleaks passed. It then hits the same local license-gate failure as clean public/dev: the shared local `dev` ref has no merge base with public history. Running the header gate against `public/dev` passes for all 46 new source files; fixture, dependency-license and script checks pass separately. See `base-check-complete.log` and `web-check-final-tip.log`.
- The 99 affected crates and direct dependents were exercised against the supplied lane DB. The first batch recorded 3,281 passes. Failed binaries were rebuilt or rerun with the prescribed serial execution for cluster-global migrations; affected doctests also pass after restoring the shared target cache. Current focused proof includes all 45 platform REST tests (19 support DB tests), 68 shared-boundary tests, the access-catalog test, 38 settings tests, 11 support Cedar tests, 18 full-feature OpenAPI drift tests and the tenant UI/refusal tests.
- One DB refusal remains identical on clean public/dev and the tip: `leave_command_preprovision_and_privilege_matrix_are_fail_closed` sees the pre-existing `leave_api.employee_import_rollback_audit_required` trigger helper among public entrypoints. Both logs have exactly the same actual/expected function lists (`base-leave-privileges.log`, `tip-leave-privileges.log`). The source is migration `20261023061209000_employee_import_rollback.sql`; this is a hand-off to the import-rollback owner, not a support change.
- Fail-before logs retain the absent base ledger/Cedar/UI contracts, old HTTP refusal, second-operator refusal, WebSocket boundary, duration clamp, read problem-details, approved-but-unstarted request expiry, pre-start withdrawal and all three nested/container/array masking regressions. The terminal-state end guard was additionally checked without changing its implementation.

Chromium product E2E, its 1440/390 light/dark axe checks, first-run-solo and the release unit's full browser/mutation/released-spec verification remain with the verifier and CI, as directed by the brief. No push was performed.

## Touch inventory

The brief authorizes support implementation and its verification across shared call sites. The inventory includes shared token fixtures, error mappings, generated contracts, copy and ratchet registries outside the named support files. No excluded lane-owned file is edited. The external hand-off file `/Users/jasonlee/Developer/console-handoff/units/ops-cockpit.md` is updated only to close this P0 slice with its evidence.

- `apps/web/src/features/platform/ui/tenant-panel.tsx`
- `apps/web/src/features/support-access/api.ts`
- `apps/web/src/features/support-access/ui/support-access.test.tsx`
- `apps/web/src/features/support-access/ui/support-access.tsx`
- `apps/web/src/lib/live/live.ts`
- `apps/web/src/lib/live/topics.ts`
- `apps/web/src/lib/react/session.ts`
- `apps/web/src/routes/app.ts`
- `apps/web/src/shell/nav.test.ts`
- `apps/web/src/shell/nav.ts`
- `apps/web/src/shell/shell.tsx`
- `backend/Cargo.lock`
- `backend/app/src/config/auth.rs`
- `backend/app/src/lifecycle_schedule.rs`
- `backend/app/src/routes/platform.rs`
- `backend/app/src/state/build.rs`
- `backend/app/src/state/mod.rs`
- `backend/app/tests/access_log_reads/support.rs`
- `backend/app/tests/action_inbox_api.rs`
- `backend/app/tests/attendance_persona_api.rs`
- `backend/app/tests/audit_api.rs`
- `backend/app/tests/auth_idle_sign_out.rs`
- `backend/app/tests/benefit_catalog_api.rs`
- `backend/app/tests/board_ack_api.rs`
- `backend/app/tests/cedar_freshness_mint.rs`
- `backend/app/tests/compliance_api.rs`
- `backend/app/tests/compliance_catalog_api.rs`
- `backend/app/tests/console_kill_switch.rs`
- `backend/app/tests/console_route_telemetry.rs`
- `backend/app/tests/consulting_engagement_api.rs`
- `backend/app/tests/current_authority.rs`
- `backend/app/tests/current_authority/fixture.rs`
- `backend/app/tests/dispatch_pipeline_api.rs`
- `backend/app/tests/emp_ui_routes/harness.rs`
- `backend/app/tests/entity_capture_journey.rs`
- `backend/app/tests/entity_registration_void/permissions.rs`
- `backend/app/tests/equipment_3r_api.rs`
- `backend/app/tests/evaluation_cycle_api.rs`
- `backend/app/tests/facilities_pilot_story.rs`
- `backend/app/tests/field_visit_api.rs`
- `backend/app/tests/finance_gl_voucher_sod.rs`
- `backend/app/tests/go_live_truth_journey.rs`
- `backend/app/tests/h5_reason_notes.rs`
- `backend/app/tests/health_readiness.rs`
- `backend/app/tests/hr_attendance_manager_scope.rs`
- `backend/app/tests/hr_attendance_self_read.rs`
- `backend/app/tests/hr_ingest_checklist_gate.rs`
- `backend/app/tests/hr_lifecycle_stage_d.rs`
- `backend/app/tests/hr_people_create/consent.rs`
- `backend/app/tests/hr_people_create_api.rs`
- `backend/app/tests/logistics_pilot_story.rs`
- `backend/app/tests/maintenance_chain_api.rs`
- `backend/app/tests/mobile_api.rs`
- `backend/app/tests/mvp_build_surface.rs`
- `backend/app/tests/notif_routing_api.rs`
- `backend/app/tests/notifications_api.rs`
- `backend/app/tests/object_graph_api.rs`
- `backend/app/tests/object_links_api.rs`
- `backend/app/tests/object_ontology_api.rs`
- `backend/app/tests/object_resolve_api.rs`
- `backend/app/tests/openapi_drift/route_sources.rs`
- `backend/app/tests/org_change_api.rs`
- `backend/app/tests/org_units_api.rs`
- `backend/app/tests/perf_pool_shed.rs`
- `backend/app/tests/period_locks_api.rs`
- `backend/app/tests/period_unlock_support/mod.rs`
- `backend/app/tests/persona_ess_http.rs`
- `backend/app/tests/platform_onboarding_e2e.rs`
- `backend/app/tests/platform_ops_recovery_api.rs`
- `backend/app/tests/purchase_request_collection_api.rs`
- `backend/app/tests/realtime_authority.rs`
- `backend/app/tests/recruiting_pipeline_api.rs`
- `backend/app/tests/registry_api.rs`
- `backend/app/tests/router_layers.rs`
- `backend/app/tests/search_api.rs`
- `backend/app/tests/settings_support/mod.rs`
- `backend/app/tests/submittable_definitions_api.rs`
- `backend/app/tests/support/http.rs`
- `backend/app/tests/support/perf.rs`
- `backend/app/tests/tenant_context_e2e.rs`
- `backend/app/tests/tenant_setup_first_run_journey.rs`
- `backend/app/tests/ux_r1_entity_routes.rs`
- `backend/app/tests/workbench_native_api.rs`
- `backend/app/tests/workflow_four_eyes_publish.rs`
- `backend/app/tests/workflow_object_context_api.rs`
- `backend/app/tests/workflow_object_kind_dynamics.rs`
- `backend/app/tests/workflow_run_read_surface.rs`
- `backend/app/tests/workflow_runtime_finalize_api.rs`
- `backend/app/tests/workflow_runtime_instance_api.rs`
- `backend/app/tests/workorder_api.rs`
- `backend/ci/gates/file-size/baseline.d/eco-g1-support.txt`
- `backend/ci/gates/tenant-isolation/src/global_tables.rs`
- `backend/crates/comms/rest/src/lib.rs`
- `backend/crates/comms/rest/tests/readiness.rs`
- `backend/crates/consulting/rest/tests/audit_atomicity.rs`
- `backend/crates/contracts/src/gen_registry.rs`
- `backend/crates/financial/rest/tests/purchase_request_list.rs`
- `backend/crates/governance/rest/src/lib.rs`
- `backend/crates/hr/rest/tests/directory_http.rs`
- `backend/crates/identity/rest/openapi/manifest.json`
- `backend/crates/identity/rest/openapi/paths/api__platform__support-sessions.get.yaml`
- `backend/crates/identity/rest/openapi/paths/api__platform__support-sessions.post.yaml`
- `backend/crates/identity/rest/openapi/paths/api__platform__support-sessions__id__approve.post.yaml`
- `backend/crates/identity/rest/openapi/paths/api__platform__support-sessions__id__end.post.yaml`
- `backend/crates/identity/rest/openapi/paths/api__platform__support-sessions__id__start.post.yaml`
- `backend/crates/identity/rest/openapi/paths/api__platform__tenant-context.post.yaml`
- `backend/crates/identity/rest/openapi/paths/api__platform__tenant-context__exit.post.yaml`
- `backend/crates/identity/rest/openapi/paths/api__platform__view-as.post.yaml`
- `backend/crates/identity/rest/openapi/paths/api__platform__view-as__exit.post.yaml`
- `backend/crates/identity/rest/openapi/paths/api__v1__support-sessions.get.yaml`
- `backend/crates/identity/rest/openapi/paths/api__v1__support-sessions__active.get.yaml`
- `backend/crates/identity/rest/openapi/paths/api__v1__support-sessions__id__decision.post.yaml`
- `backend/crates/identity/rest/openapi/paths/api__v1__support-sessions__id__end.post.yaml`
- `backend/crates/identity/rest/openapi/schemas/AccessDomain.yaml`
- `backend/crates/identity/rest/openapi/schemas/ActiveSupportSessions.yaml`
- `backend/crates/identity/rest/openapi/schemas/MobilePasskeyStepUpStartResponse.yaml`
- `backend/crates/identity/rest/openapi/schemas/PlatformExitResponse.yaml`
- `backend/crates/identity/rest/openapi/schemas/PlatformTenantContextStartRequest.yaml`
- `backend/crates/identity/rest/openapi/schemas/PlatformTenantContextStartResponse.yaml`
- `backend/crates/identity/rest/openapi/schemas/PlatformViewAsStartRequest.yaml`
- `backend/crates/identity/rest/openapi/schemas/PlatformViewAsStartResponse.yaml`
- `backend/crates/identity/rest/openapi/schemas/SupportAccessRecord.yaml`
- `backend/crates/identity/rest/openapi/schemas/SupportOperatorDecision.yaml`
- `backend/crates/identity/rest/openapi/schemas/SupportRefusal.yaml`
- `backend/crates/identity/rest/openapi/schemas/SupportRequest.yaml`
- `backend/crates/identity/rest/openapi/schemas/SupportSession.yaml`
- `backend/crates/identity/rest/openapi/schemas/SupportSessionDecision.yaml`
- `backend/crates/identity/rest/openapi/schemas/SupportSessionMetadata.yaml`
- `backend/crates/identity/rest/openapi/schemas/SupportSessions.yaml`
- `backend/crates/identity/rest/openapi/schemas/SupportTenantDecision.yaml`
- `backend/crates/identity/rest/src/context.rs`
- `backend/crates/identity/rest/src/openapi.rs`
- `backend/crates/identity/rest/src/policy/preview.rs`
- `backend/crates/identity/rest/tests/authentication_locking.rs`
- `backend/crates/identity/rest/tests/org_setup.rs`
- `backend/crates/inbox/rest/tests/api.rs`
- `backend/crates/leave/rest/tests/leave_http_personas.rs`
- `backend/crates/messenger/rest/tests/api.rs`
- `backend/crates/notices/rest/src/lib.rs`
- `backend/crates/notices/rest/tests/api.rs`
- `backend/crates/notifications/rest/tests/api.rs`
- `backend/crates/onboarding/rest/tests/common/mod.rs`
- `backend/crates/ontology/rest/src/lib.rs`
- `backend/crates/ontology/rest/tests/company_conformance/harness.rs`
- `backend/crates/ontology/rest/tests/object_policy_attach_as_runtime_role.rs`
- `backend/crates/ontology/rest/tests/object_type_cas_as_runtime_role.rs`
- `backend/crates/ontology/rest/tests/object_type_lifecycle_over_http.rs`
- `backend/crates/orgchange/rest/src/access.rs`
- `backend/crates/payroll/rest/src/lib.rs`
- `backend/crates/payroll/rest/tests/api.rs`
- `backend/crates/payroll/rest/tests/payslip_draft_api.rs`
- `backend/crates/payroll/rest/tests/run_lifecycle_api.rs`
- `backend/crates/platform/access-rest/src/catalog.rs`
- `backend/crates/platform/access-rest/tests/support/mod.rs`
- `backend/crates/platform/auth-rest/src/context/request.rs`
- `backend/crates/platform/auth-rest/src/group_admin/actor.rs`
- `backend/crates/platform/auth-rest/src/group_admin/routes.rs`
- `backend/crates/platform/auth-rest/src/token/issue.rs`
- `backend/crates/platform/auth-rest/tests/group_admin_tenant_context.rs`
- `backend/crates/platform/auth/src/jwt.rs`
- `backend/crates/platform/auth/src/jwt/verify.rs`
- `backend/crates/platform/auth/src/jwt_keys.rs`
- `backend/crates/platform/auth/src/webauthn/step_up_kind.rs`
- `backend/crates/platform/auth/tests/jwt_es256.rs`
- `backend/crates/platform/auth/tests/jwt_key_rotation.rs`
- `backend/crates/platform/auth/tests/jwt_verifier.rs`
- `backend/crates/platform/authz-rest/src/lib.rs`
- `backend/crates/platform/authz/src/access/catalog.rs`
- `backend/crates/platform/authz/src/access/project.rs`
- `backend/crates/platform/authz/src/cedar_pbac/actions/mod.rs`
- `backend/crates/platform/authz/src/cedar_pbac/actions/support_session.rs`
- `backend/crates/platform/authz/src/decide.rs`
- `backend/crates/platform/authz/src/platform.rs`
- `backend/crates/platform/authz/src/principal.rs`
- `backend/crates/platform/authz/tests/support_session.rs`
- `backend/crates/platform/authz/tests/support_session/reads.rs`
- `backend/crates/platform/db/migrations/20261023090000000_support_sessions.sql`
- `backend/crates/platform/db/src/audit_tx.rs`
- `backend/crates/platform/db/src/lib.rs`
- `backend/crates/platform/db/src/support.rs`
- `backend/crates/platform/platform-rest/Cargo.toml`
- `backend/crates/platform/platform-rest/src/error.rs`
- `backend/crates/platform/platform-rest/src/lib.rs`
- `backend/crates/platform/platform-rest/src/routes.rs`
- `backend/crates/platform/platform-rest/src/state_builders.rs`
- `backend/crates/platform/platform-rest/src/support.rs`
- `backend/crates/platform/platform-rest/src/support_store.rs`
- `backend/crates/platform/platform-rest/src/support_tenant.rs`
- `backend/crates/platform/platform-rest/src/view_as.rs`
- `backend/crates/platform/platform-rest/tests/fixtures/rename.rs`
- `backend/crates/platform/platform-rest/tests/fixtures/support_proof.rs`
- `backend/crates/platform/platform-rest/tests/fixtures/support_sessions.rs`
- `backend/crates/platform/platform-rest/tests/onboard_seeds_config_objects.rs`
- `backend/crates/platform/platform-rest/tests/ops_dashboard.rs`
- `backend/crates/platform/platform-rest/tests/ops_recovery.rs`
- `backend/crates/platform/platform-rest/tests/platform_groups.rs`
- `backend/crates/platform/platform-rest/tests/remove_tenant.rs`
- `backend/crates/platform/platform-rest/tests/support_ledger.rs`
- `backend/crates/platform/platform-rest/tests/support_sessions.rs`
- `backend/crates/platform/platform-rest/tests/support_sessions/boundary.rs`
- `backend/crates/platform/platform-rest/tests/view_as.rs`
- `backend/crates/platform/realtime/src/auth.rs`
- `backend/crates/platform/realtime/src/reader.rs`
- `backend/crates/platform/realtime/tests/sse_session.rs`
- `backend/crates/platform/realtime/tests/sse_token_expired.rs`
- `backend/crates/platform/realtime/tests/ws_stream.rs`
- `backend/crates/platform/request-context/src/audit_context/access_log.rs`
- `backend/crates/platform/request-context/src/commands.rs`
- `backend/crates/platform/request-context/src/current_claims.rs`
- `backend/crates/platform/request-context/src/error_response.rs`
- `backend/crates/platform/request-context/src/lib.rs`
- `backend/crates/platform/request-context/src/principal.rs`
- `backend/crates/platform/request-context/src/support.rs`
- `backend/crates/platform/request-context/src/support_problem.rs`
- `backend/crates/production/rest/tests/production_lifecycle_http.rs`
- `backend/crates/registry/rest/src/lib.rs`
- `backend/crates/registry/rest/tests/equipment_admin.rs`
- `backend/crates/sales/rest/src/lib.rs`
- `backend/crates/settings/domain/src/keys/mod.rs`
- `backend/crates/settings/domain/src/keys/support.rs`
- `backend/crates/settings/domain/tests/registry.rs`
- `backend/crates/settings/domain/tests/sql_definitions.rs`
- `backend/crates/support/rest/src/lib.rs`
- `backend/crates/support/rest/tests/authz.rs`
- `backend/crates/support/rest/tests/intake.rs`
- `backend/crates/todos/rest/src/lib.rs`
- `backend/crates/workorder/rest/tests/evidence_without_storage.rs`
- `backend/crates/workorder/rest/tests/mobile_device_registration.rs`
- `backend/crates/workorder/rest/tests/mobile_evidence.rs`
- `backend/crates/workorder/rest/tests/mobile_sync.rs`
- `backend/openapi/openapi.yaml`
- `backend/openapi/shared/schemas/MobilePasskeyStepUpBinding.yaml`
- `backend/openapi/shared/schemas/MobileStepUpActionKind.yaml`
- `docs/ops/support-access.md`
- `e2e/support-access.spec.ts`
- `packages/api/src/index.ts`
- `packages/api/src/schema.d.ts`
- `packages/api/src/step-up.ts`
- `packages/api/src/support-sessions.ts`
- `packages/i18n/src/catalogs/en.ts`
- `packages/i18n/src/catalogs/en/access-codes.ts`
- `packages/i18n/src/catalogs/en/enum.ts`
- `packages/i18n/src/catalogs/en/support-access.ts`
- `packages/i18n/src/catalogs/en/support.ts`
- `packages/i18n/src/catalogs/ko.ts`
- `packages/i18n/src/catalogs/ko/access-codes.ts`
- `packages/i18n/src/catalogs/ko/enum.ts`
- `packages/i18n/src/catalogs/ko/support-access.ts`
- `packages/i18n/src/catalogs/ko/support.ts`
- `scripts/api-compat.test.ts`
- `scripts/reach-baseline.json`
- `scripts/standing-text.d/eco-g1-support.json`

## Round 2 reviewed surfaces and regression proof

| Surface | Readable within granted domain | Protected without a personal grant | Content proof |
| --- | --- | --- | --- |
| `/api/v1/org-units` | id, kind, name, parentId, status, effectiveFrom, updatedAt, headcount | head name and employee reference | `support_sessions/surfaces.rs`; real-handler E2E asserts name, kind, status, dates and headcount |
| `/api/v1/org-structure` | tenant_name, phase, as_of, organization names, counts and status chips | head identity and individual assignment facts | same DB test; real-handler E2E asserts tenant, phase, date and entity name |
| `/api/v1/legal-entities` | entity identity, business state, registration facts and counts | representatives, directors, co-owners and named reviews | same DB test; real-handler E2E asserts entity name |
| `/api/v1/workplaces` | workplace identity, name, kind, business state and counts | representative name, contact email and mobile | same DB test; real-handler E2E asserts name and headcount; tenant-wide route reuses the existing scoped, dated entity read |
| `/api/v1/employees` | pagination totals and the registry’s structural org_unit_id | individual facts (0211), including name, contacts and employment facts | same DB test; real-handler E2E asserts count and masked names |

The response registry is `20261023100100000_support_response_classes.sql`; unknown paths, containers and fields fail closed. Tenant durations are entered in minutes and shown with locale-formatted hours and minutes. Active-session details show the support deadline rather than a stale approval deadline.

Negative DB tests cover non-holder list/approve/deny/end with no ledger change, post-verification hardware-key eligibility for both operators, and revocation inside a handler with an audited 401. The key-upgrade injection isolates the support hardware guard from WebAuthn’s independent backup-flag check. Policy tests set both tenant keys, prove the resulting deadlines and cap, and reject values above registry defaults. A capacity fixture finds a custom approval holder among 2,000 active accounts with one existence query, then proves revoking that grant refuses the next request.
