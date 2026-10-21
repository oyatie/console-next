//! The refusal the checker returns, and who changed the record.
//!
//! `Refusal` serializes to the error-model members (`status`, `code`,
//! `errors[]`), so it fits the RFC 9457 container or the current
//! `{error: …}` envelope unchanged (api-conventions ERR-1). It carries codes
//! only; copy lives in the client catalogs.

use serde::Serialize;
use serde_json::Value;

/// 409: a field PATCH `test` failed (ME-8).
pub const FIELD_CONFLICT: &str = "field_conflict";
/// 409: a command `expected` fact changed (ME-7).
pub const STALE_FACTS: &str = "stale_facts";
/// 422: a write without its precondition (ME-12).
pub const PRECONDITION_MISSING: &str = "precondition_missing";
/// 403: a precondition on a path the caller may not read (ME-11). Reuses the
/// existing code, which already has catalog entries.
pub const FORBIDDEN: &str = "forbidden";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Refusal {
    pub status: u16,
    pub code: &'static str,
    pub errors: Vec<Entry>,
}

/// One refused path. `pointer` is the record path the precondition named,
/// which is also the form field it binds to (ME-8).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Entry {
    pub pointer: String,
    pub code: &'static str,
    /// The value now on the record. Omitted when the path is absent; JSON
    /// `null` means the record holds `null`. Only ever set for a path that
    /// passed the read check (ME-11).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

impl Refusal {
    pub(crate) fn missing(pointers: Vec<String>) -> Self {
        Self::bare(422, PRECONDITION_MISSING, pointers)
    }

    pub(crate) fn forbidden(pointer: &str) -> Self {
        Self::bare(403, FORBIDDEN, vec![pointer.to_owned()])
    }

    pub(crate) fn conflict(code: &'static str, errors: Vec<Entry>) -> Self {
        Self {
            status: 409,
            code,
            errors,
        }
    }

    fn bare(status: u16, code: &'static str, pointers: Vec<String>) -> Self {
        let errors = pointers
            .into_iter()
            .map(|pointer| Entry {
                pointer,
                code,
                current: None,
                actor: None,
                at: None,
            })
            .collect();
        Self {
            status,
            code,
            errors,
        }
    }
}

/// The result of the `0147` covert-label clearance check on the record's last
/// writer (OD-RT-3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActorClearance {
    /// The caller may see who made the change.
    Visible,
    /// The change was covert-labelled for this caller: the actor stays hidden.
    Covert,
}

/// Who last changed the record, and when (`updated_by_name`, `updated_at`),
/// after the caller's Cedar read check (ME-11, spec A2).
///
/// The actor can only be set together with a clearance result, and the
/// default shows nobody, so forgetting the covert check hides the actor
/// instead of leaking it (OD-RT-3, fail closed).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Provenance {
    actor: Option<String>,
    at: Option<String>,
}

impl Provenance {
    /// `at` is the canonical timestamp text the aggregate GET returns (ME-9).
    #[must_use]
    pub fn new(actor: impl Into<String>, at: impl Into<String>, clearance: ActorClearance) -> Self {
        Self {
            actor: (clearance == ActorClearance::Visible).then(|| actor.into()),
            at: Some(at.into()),
        }
    }

    pub(crate) fn entry(
        &self,
        code: &'static str,
        pointer: &str,
        current: Option<&Value>,
    ) -> Entry {
        Entry {
            pointer: pointer.to_owned(),
            code,
            current: current.cloned(),
            actor: self.actor.clone(),
            at: self.at.clone(),
        }
    }
}
