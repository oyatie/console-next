//! Resolution: which value is in force for a key, at a scope, at a moment.
//! The most specific scope wins (legal entity or 사업장 → tenant → code
//! default); within a scope the latest row with `effective_from <= as_of`
//! wins. A future row is not in force yet.

use crate::{Governance, SettingError, SettingKey, SettingValue};
use console_kernel_core::{Resolved, SettingVersionId, Timestamp};
use uuid::Uuid;

/// One append-only override row, as the adapter loads it for one tenant and
/// one key. `(scope_entity_id, effective_from)` is unique per key (DB index).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OverrideRow {
    pub id: Uuid,
    /// `None` = the tenant-wide row; `Some` = a legal entity or 사업장.
    pub scope_entity_id: Option<Uuid>,
    pub value: SettingValue,
    pub effective_from: Timestamp,
}

/// The value in force for `key` at `as_of`, for `entity` (or tenant-wide
/// when `None`). Rows of a key with no tenant override path are ignored: the
/// code default is the only value.
///
/// # Errors
/// [`SettingError::FactUndeclared`] for a tenant fact with no row in force.
pub fn resolve(
    key: SettingKey,
    rows: &[OverrideRow],
    entity: Option<Uuid>,
    as_of: Timestamp,
) -> Result<Resolved<SettingValue>, SettingError> {
    let def = key.def();
    let latest_at = |scope: Option<Uuid>| {
        rows.iter()
            .filter(|r| r.scope_entity_id == scope && r.effective_from <= as_of)
            .max_by_key(|r| r.effective_from)
    };
    let row = if def.governance == Governance::Tenant {
        entity
            .and_then(|e| latest_at(Some(e)))
            .or_else(|| latest_at(None))
    } else {
        None
    };
    match (row, def.default) {
        (Some(r), _) => Ok(Resolved {
            value: r.value,
            version: SettingVersionId::Override(r.id),
        }),
        (None, Some(value)) => Ok(Resolved {
            value,
            version: SettingVersionId::CodeDefault,
        }),
        (None, None) => Err(SettingError::FactUndeclared(key)),
    }
}
