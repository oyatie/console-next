//! Process entry points per role: serve, migrate, worker, shutdown.

pub(crate) mod healthcheck;
pub(crate) mod migrate;
pub(crate) mod schema_check;
pub(crate) mod serve;
pub(crate) mod shutdown;
pub(crate) mod worker;
