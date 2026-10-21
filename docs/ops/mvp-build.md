# Backend build profiles

`backend/app/Cargo.toml` owns the feature lists. The default `mvp` profile includes
the always-on organisation and HR core plus attendance. `full` enables the other
modules. A module compiled out of a profile exposes no routes or periodic loops.
Migrations always apply to the shared schema, regardless of enabled features.

Before promoting a module into `mvp`, review its feature dependencies, route mounts,
worker loops and state initialization; test its routes and isolation, and confirm
the default build still excludes unrelated modules. `dev-auth` remains opt-in and
is excluded from `default`, `mvp` and `full`.
