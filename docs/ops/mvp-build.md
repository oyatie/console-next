# Backend build profiles

`backend/app/Cargo.toml` owns the feature lists. The default `mvp` profile includes
the always-on organisation and HR core plus attendance and payroll. `full` enables the other
modules. A module compiled out of a profile exposes no routes or periodic loops.
Migrations always apply to the shared schema, regardless of enabled features.
Privacy rights filing and own-history APIs are always-on self-service capabilities;
other compliance routes remain gated by the `compliance` feature.
Console route telemetry ingestion is available only in `full`; the default
release build exposes no telemetry ingestion route.

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
