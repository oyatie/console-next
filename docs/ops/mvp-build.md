# Backend build profiles

`backend/app/Cargo.toml` owns the feature lists. The default `mvp` profile includes
the always-on organisation and HR core plus attendance, leave, payroll and inbox.
`full` enables the other modules. A module compiled out of a profile exposes no
routes or periodic loops.
Migrations always apply to the shared schema, regardless of enabled features.
Privacy rights filing and own-history APIs are always-on self-service capabilities;
other compliance routes remain gated by the `compliance` feature.
Console route telemetry ingestion is available only in `full`; the default
release build exposes no telemetry ingestion route.

Before promoting a module into `mvp`, review its feature dependencies, route mounts,
worker loops and state initialization; test its routes and isolation, and confirm
the default build still excludes unrelated modules. `dev-auth` remains opt-in and
is excluded from `default`, `mvp` and `full`.

## Tenant activation for additional modules

A module may become default-on for tenants whose plan includes it after its server routes, navigation, tenant isolation and opt-out have passed release qualification. Start with designated tenants. Preserve each tenant's explicit choice when the platform default changes. A missing entitlement, a disabled tenant setting or a failed policy read must withhold the module.

Resolve admission on the server before returning protected data, accepting writes or replaying receipts. The same decision governs discovery, exports and background jobs. Each operation still requires its own role, resource scope and effective date. Record who changed the tenant setting and when it took effect.

Location collection, external delivery, financial posting and other consequential effects require their own explicit authorization or activation. A tenant opt-out stops new work. Define how pending operations, historical records and legally required self-service access continue before promotion. Published candidate artifacts and Cargo features describe what the build can serve.

Payroll promotion decision (2026-11-02): the owner approved payroll in the
production build for closed alpha, enabled by default for all tenants. No tenant
override rows are created; existing overrides continue to apply. Readiness also
requires the payroll feature to be compiled in. Payroll APIs enforce module
admission through Cedar before their existing scope and operation decisions.
The shared inbox omits payroll reviews when the module is disabled or tenant
pay:edit is absent; legacy titles alone do not grant access.

Promotion review: payroll enables only the existing payroll REST and PostgreSQL
adapter dependencies. Its routes and route inventory use `cfg(feature = "payroll")`;
state is initialized at the route mount. Payroll adds no periodic loop: the
workflow outbox drainer still requires `workorder`, which remains outside `mvp`.
OpenAPI fragments and payroll integration tests remain part of the payroll REST
crate; the full OpenAPI drift suite checks the generated contract. Default-build
surface tests cover payroll availability and unrelated-module isolation; the
same tests without default features prove compiled-out payroll stays hidden.

Leave and inbox promotion review (2026-11-20): `leave` enables only the
`console-leave-rest` dependency (`console-leave-adapter-postgres` and
`console-leave-domain` were already non-optional for the HR core and
`LEAVE_COMMAND_DATABASE_URL`), and `inbox` enables only the `console-inbox-rest`
dependency (`console-inbox-adapter-postgres` and `console-action-inbox-application`
were already non-optional). `routes/people.rs` (`mount_leave`), `routes/comms.rs`
(`mount_inbox`), `routes/surfaces.rs` (`CONFIGURED_ROUTE_SURFACES`), and
`tests/openapi_drift/route_sources.rs` (`CONFIGURED_ROUTE_SOURCES`) gate both
surfaces under `cfg(feature = "leave")` and `cfg(feature = "inbox")`. Shared state
(`PgLeaveStore`, `PgInboxStore`, `LEAVE_COMMAND_DATABASE_URL`, and `policy_step_up`
for passkey receipt confirmation) is initialized at the route mounts and `TenantDeps`,
and neither module introduces any periodic loop in `run/worker.rs` or `run/serve.rs`.
`dev-auth` remains excluded from `default`, `mvp`, and `full` (verified by
`console-gate-dev-auth-absence`), and `mvp_build_surface` verifies `leave` and
`inbox` route availability in `mvp` alongside unrelated-module 404s and
`--no-default-features` compiled-out isolation.

## Evaluation enrollment

An installation serving the evaluation build admits evaluation requests only for an enrolled organization. The tenant-wide setting `module.evaluation.enabled` defaults to true for that organization. An administrator can schedule an opt-out in Settings → Operations. Cycle management and cross-person ledger access require organization-wide authority. An enrolled employee or manager with a submission grant can work on their own assigned reviews. Enrollment creates no cycles, assignments or notifications.

The release operator uses an individually attributable database session with deployment privileges and the approved change reference to record enrollment. The realtime service suppresses maintenance events from a direct login as the migration account `console_app`. Bind the organization UUID, decision and reference from the approved change. Execute this transaction with psql variables `org`, `enabled` and `change_ref`. Check the returned decision against the request. Reusing a reference for a different decision requires a new change. The operator role must have access to the confirmed tenant. The application runtime can only read that tenant's history.

```sql
BEGIN;
SELECT set_config('app.current_org', :'org'::uuid::text, true);
SELECT id FROM organizations WHERE id = :'org'::uuid FOR UPDATE;
INSERT INTO tenant_module_enrollments (org_id, module_key, enabled, change_ref)
VALUES (:'org'::uuid, 'evaluation', :'enabled'::boolean, :'change_ref')
ON CONFLICT (org_id, module_key, change_ref) DO NOTHING;
SELECT enabled, change_ref, recorded_by, recorded_at FROM tenant_module_enrollments
WHERE org_id = :'org'::uuid AND module_key = 'evaluation'
ORDER BY revision DESC LIMIT 1;
COMMIT;
```

Withdrawal appends a disabled decision using a new reference. Requests admitted after that commit, including retries carrying an earlier command key, are refused. In-flight requests can finish. Historical evaluation records are preserved. No tenant is enrolled by the migration.
