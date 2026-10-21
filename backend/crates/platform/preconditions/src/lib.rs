//! The shared server-side precondition checker (spec `data-display` A1, RT-8).
//!
//! Rules from `console-react/docs/design/concurrent-editing.md`:
//! - a field PATCH carries a JSON Patch `test` per touched path (ME-6); a write
//!   with no preceding test is refused with 422 `precondition_missing` (ME-12);
//! - a failed test is a 409 `field_conflict` (ME-8), except when the patch
//!   writes the value the record already holds (ME-3);
//! - a command asserts its facts in `expected` (ME-7); a changed fact is a
//!   409 `stale_facts`;
//! - values compare canonically: numbers numerically (ME-9, RFC 6902 §4.6);
//! - masked fields are tested through their `<field>_rev` sibling (ME-10);
//! - every tested path, and everything under it, passes the caller's read
//!   check first, or the request is refused with 403 unevaluated (ME-11).
//!
//! The checker only decides. The caller loads `current` under the row lock,
//! supplies the Cedar read check as `can_read`, and on `Ok` applies the
//! non-`test` ops in order.

mod canonical;
mod evaluate;
mod refusal;

pub use canonical::json_eq;
pub use evaluate::{check_expected, check_patch};
pub use refusal::{
    ActorClearance, Entry, FIELD_CONFLICT, FORBIDDEN, PRECONDITION_MISSING, Provenance, Refusal,
    STALE_FACTS,
};

use serde::Deserialize;
use serde_json::Value;

/// One RFC 6902 operation, as sent with `application/json-patch+json`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum PatchOp {
    Test { path: String, value: Value },
    Add { path: String, value: Value },
    Replace { path: String, value: Value },
    Remove { path: String },
    Move { from: String, path: String },
    Copy { from: String, path: String },
}

impl PatchOp {
    /// Paths this op changes or reads from. Each needs a preceding `test`
    /// (ME-12). `copy`'s source is listed too: it is stricter than RFC 6902,
    /// and it means a `copy` can never move a value nobody asserted.
    fn touched(&self) -> Vec<&str> {
        match self {
            Self::Test { .. } => Vec::new(),
            Self::Add { path, .. } | Self::Replace { path, .. } | Self::Remove { path } => {
                vec![path]
            }
            Self::Move { from, path } | Self::Copy { from, path } => vec![from, path],
        }
    }
}

/// One command fact (ME-7): `{ "path": "/state", "value": "PENDING" }`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Fact {
    pub path: String,
    pub value: Value,
}
