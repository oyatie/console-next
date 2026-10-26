//! Cedar/PBAC cutover contracts.
//!
//! This module is intentionally dependency-free: it does not pull in Cedar yet
//! and it is not on any live request path by itself. It gives later slices a
//! typed server-side boundary for Cedar authorization requests, compiled-bundle
//! cache identity, subject-freshness checks, and dual-engine fail-closed
//! semantics while preserving the existing legacy authorization functions.

/// Real Cedar bundle compile/validate + evaluation adapter.
///
/// The matrix-feature bundles feed the shadow lane only; Cedar-only actions
/// with an enrolled per-action schema are enforced live through [`enforce`].
pub mod engine;

/// Per-action required-fact Cedar schemas (BW-28 fail-closed, decisions D0.1).
pub mod action_schema;

/// Cedar-only SoD actions, one file per action, and their registry.
pub mod actions;

/// Typed server-computed facts carried into the Cedar context (D0.1 §4).
pub mod facts;

/// The live call for a Cedar-only action: enrolled schema + facts, `Allow` or deny.
pub mod enforce;

/// Cedar policy authoring + point-decision evaluation (Policy Studio spine,
/// arch §5a/§5b/§5c). Pure domain logic only (no DB / no request-context) so the
/// crate DAG stays acyclic; persistence + REST live in `authz-rest`.
pub mod authoring;

/// Coexistence-map loader: parse the canonical map JSON into typed
/// [`CoexistenceMapEntry`] rows.
///
/// This submodule is ADDITIVE/INERT (Cedar-activation slice 3): nothing consults
/// the produced entries on a live request path yet (that is the shadow-wiring
/// slice). It only turns the org-agnostic spec map
/// (`docs/specs/cedar-pbac-coexistence-map.json`) into the entries the
/// already-existing boundary consumes, and it fails closed on any drift between
/// a map action id and the [`Feature`] matrix so an unmodeled/typo action can
/// never silently enroll or drop.
pub mod map;

/// Test-only lock on the four [`DualEngineMode`] arms: who decides in each mode,
/// and that every Cedar-requiring mode still denies an invalid enrollment map, a
/// stale identity, an RLS mismatch, or an unavailable bundle.
#[cfg(test)]
mod mode_contract;

/// List-filtering residual (arch §5d / decision D1): lower our own no-code
/// condition grammar to a parameterized SQL `WHERE` fragment that composes as
/// `WHERE <RLS org floor> AND <residual>`. Pure (no DB); the consumer binds the
/// values. Fail-closed: no permit ⇒ `WHERE FALSE`, `forbid` ⇒ AND-NOT, any
/// untranslatable term ⇒ the whole filter collapses to `FALSE`.
pub mod residual;

/// One server-loaded snapshot for Cedar point decisions and D1 visible sets.
pub mod visible;

// The `engine` and `map` module docs above resolve `Feature` and
// `Feature::from_str` links in this scope.
use std::str::FromStr;

use crate::Feature;

mod boundary;
mod coexistence;
mod decision;
mod observe;
mod request;

pub use boundary::*;
pub use coexistence::*;
pub use decision::*;
pub use observe::*;
pub use request::*;
