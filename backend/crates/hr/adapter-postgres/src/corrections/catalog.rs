//! Load and lock the tenant catalog entry before any correction path writes it.

use console_hr_domain::corrections::catalog::{kind_for_field, validate_entry};
use console_kernel_core::KernelError;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use super::{FieldValue, LockedEmployee};
use crate::{HrError, lifecycle::title_reason::coded};
use serde_json::{Map, Value, json};

pub(crate) async fn check_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    fields: &[FieldValue],
) -> Result<(), HrError> {
    for (field, value) in fields {
        if kind_for_field(field).is_none() {
            continue;
        }
        let id = value
            .as_deref()
            .and_then(|v| Uuid::parse_str(v).ok())
            .ok_or_else(|| HrError::validation(format!("{field} must be a UUID")))?;
        let entry: Option<(String, bool)> = sqlx::query_as(
            "SELECT kind, active FROM job_titles WHERE org_id = $1 AND id = $2 FOR SHARE",
        )
        .bind(org)
        .bind(id)
        .fetch_optional(tx.as_mut())
        .await?;
        let (kind, active) = entry.ok_or_else(|| {
            coded(
                KernelError::validation(format!(
                    "{field} is not an active catalog entry of its kind"
                ))
                .with_code("job_title_unknown")
                .with_field(field),
            )
        })?;
        validate_entry(field, &kind, active).map_err(coded)?;
    }
    Ok(())
}

/// Catalog IDs are safe to compare in the audit; other field values stay in the restricted ledger.
pub(super) fn audit_snapshots(
    head: &LockedEmployee,
    fields: &[FieldValue],
) -> (Option<Value>, Option<Value>) {
    let catalog: Vec<_> = fields
        .iter()
        .filter(|(field, _)| kind_for_field(field).is_some())
        .collect();
    if catalog.is_empty() {
        return (None, None);
    }
    let before: Map<String, Value> = catalog
        .iter()
        .map(|(field, _)| (field.clone(), json!(head.current(field))))
        .collect();
    let after: Map<String, Value> = catalog
        .iter()
        .map(|(field, value)| (field.clone(), json!(value)))
        .collect();
    (Some(json!({"classification": before})), Some(json!(after)))
}
