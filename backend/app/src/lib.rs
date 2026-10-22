//! `console-app` composition root.
//!
//! This crate owns the process boundary: 12-factor configuration, health and
//! readiness endpoints, telemetry, database dependency wiring, and graceful
//! shutdown. Domain behavior lands in narrower crates and is composed here.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

#[cfg(feature = "workspace")]
pub mod action_inbox;
mod audit_chain_signer;
pub mod cedar_parity;
#[cfg(all(feature = "dev-auth", not(debug_assertions)))]
compile_error!("the dev-auth feature is forbidden in non-development builds");

mod coldstart_guard;
#[cfg(feature = "workspace")]
mod collaboration;
mod console_telemetry;
mod entity_wiring;
mod error_i18n;
#[cfg(feature = "facilities")]
mod facilities_schedule;
mod hr;
pub mod lifecycle;
mod lifecycle_schedule;
/// Scheduled org changes, `pub` for the clock-injected tests (org-02).
pub mod org_change_schedule;
/// Scheduled lifecycle events runner, `pub` for the clock-injected tests.
pub use hr::apply_due_lifecycle_events;
mod audit_api;
mod config;
mod error;
mod http;
#[cfg(feature = "mail")]
mod mail_sync;
#[cfg(feature = "workspace")]
pub mod objects;
#[cfg(feature = "office")]
pub mod office;
#[cfg(feature = "recruiting")]
mod recruiting_hire;
pub mod requests;
mod routes;
mod run;
mod spa;
mod state;
mod telemetry;
mod wiring;
#[cfg(feature = "workspace")]
mod workbench;
#[cfg(feature = "workspace")]
mod workbench_native;
#[cfg(feature = "workorder")]
mod workflow_drain;
#[cfg(feature = "workspace")]
mod workflow_object_context;
#[cfg(feature = "workspace")]
pub mod workflow_schedules;
#[cfg(feature = "workspace")]
mod workflow_studio;
// --- lane: UX-R2 ENDS ---
mod workplace_close_schedule;

pub use crate::audit_api::AUDIT_ATTESTATION_ROUTE_PATH;
pub use crate::audit_api::AUDIT_ROUTE_PATH;
pub use crate::audit_api::AUDIT_ROUTE_PATHS;
pub use crate::config::AppConfig;
pub use crate::config::AppLinksConfig;
pub use crate::config::auth::JwtVerifierConfig;
pub use crate::config::role::AppRole;
pub use crate::error::AppError;
pub use crate::http::metrics::install_metrics_recorder;
pub use crate::routes::build_router;
pub use crate::run::healthcheck::healthcheck;
use crate::run::migrate::MIGRATOR;
pub use crate::run::migrate::run_migrations;
pub use crate::run::schema_check::run_schema_check;
pub use crate::run::serve::assert_no_dev_auth_personas;
pub use crate::run::serve::serve;
pub use crate::state::AppState;
pub use crate::state::DatabaseDependency;
pub use crate::telemetry::TelemetryGuard;
pub use crate::telemetry::init_tracing;

pub use routes::surfaces::{CONFIGURED_ROUTE_SURFACES, ConfiguredRouteSurface};

mod schema_install;

pub use http::support_reference::OPERATIONS as SUPPORT_REFERENCE_ROUTE_OPERATIONS;
