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

All profiles enable the approvals list, document and decision endpoints by default.
To disable them, include `no-approvals` in `CONSOLE_RELEASE_TOGGLES` and restart the
service. This takes precedence over `approvals`. The module then reports that it
is unavailable, and its endpoints return 404 to authenticated callers. The service
rejects any other `no-` opt-out at startup.

Before promoting a module into `mvp`, review its feature dependencies, route mounts,
worker loops and state initialization; test its routes and isolation, and confirm
the default build still excludes unrelated modules. `dev-auth` remains opt-in and
is excluded from `default`, `mvp` and `full`.

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

The native image job runs the release journey after loading the built image.
To repeat it on a Linux Docker host with the image loaded and Chromium installed, run
`CONSOLE_RELEASE_IMAGE=console-platform:amd64 npx playwright test --config=playwright.release.config.ts`.
Use the locally built architecture tag. The release stack uses the normal E2E slot's
backend, Postgres and S3 ports. Stop the normal stack first or set `E2E_SLOT` to
an unused slot. The release run has its own Compose project, volumes and passkey cache.
The test migrates a disposable database,
signs in with a passkey and reads Home, the inbox, an employee record and approvals.
