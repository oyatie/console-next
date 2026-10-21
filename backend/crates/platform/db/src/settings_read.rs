//! ADR-006 shared settings reads on the caller's armed transaction.
use std::collections::BTreeMap;

use console_kernel_core::{KernelError, OrgId, Resolved, Timestamp};
use console_settings_domain::{OverrideRow, SettingError, SettingKey, SettingValue, resolve};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// Resolved values of a key set, one `Result` per key (a tenant fact with no
/// row in force is `Err(FactUndeclared)`).
pub type ResolvedSettings = BTreeMap<SettingKey, Result<Resolved<SettingValue>, SettingError>>;

/// Every override row of `keys` for the armed tenant, at the tenant scope
/// and, when given, at `entity`. One SELECT; runs on the caller's armed
/// transaction (`with_org_conn` / `with_audits`).
///
/// # Errors
/// Internal when the query fails or a stored value no longer parses as its
/// key's kind (fail closed: never fall back to the default).
pub async fn load_rows_in_tx(
    conn: &mut PgConnection,
    org: OrgId,
    keys: &[SettingKey],
    entity: Option<Uuid>,
) -> Result<BTreeMap<SettingKey, Vec<OverrideRow>>, KernelError> {
    let wire: Vec<&str> = keys.iter().map(|k| k.as_str()).collect();
    let rows = sqlx::query(
        "SELECT id, key, scope_entity_id, value, effective_from
           FROM tenant_setting_overrides
          WHERE org_id = $1 AND key = ANY($2)
            AND (scope_entity_id IS NULL OR scope_entity_id = $3)
          ORDER BY effective_from",
    )
    .bind(org.as_uuid())
    .bind(&wire)
    .bind(entity)
    .fetch_all(conn)
    .await
    .map_err(db_error)?;
    let mut out: BTreeMap<SettingKey, Vec<OverrideRow>> = BTreeMap::new();
    for row in rows {
        let wire_key: String = row.try_get("key").map_err(db_error)?;
        let Ok(key) = wire_key.parse::<SettingKey>() else {
            continue;
        };
        let raw: serde_json::Value = row.try_get("value").map_err(db_error)?;
        let value = key.def().parse(&raw).ok_or_else(|| {
            tracing::error!(key = key.as_str(), "stored setting value does not parse");
            KernelError::internal("stored setting value does not match its definition")
        })?;
        out.entry(key).or_default().push(OverrideRow {
            id: row.try_get("id").map_err(db_error)?,
            scope_entity_id: row.try_get("scope_entity_id").map_err(db_error)?,
            value,
            effective_from: row.try_get("effective_from").map_err(db_error)?,
        });
    }
    Ok(out)
}

/// The values of `keys` in force at `as_of` for `entity` (or tenant-wide).
///
/// # Errors
/// As [`load_rows_in_tx`].
pub async fn resolve_in_tx(
    conn: &mut PgConnection,
    org: OrgId,
    keys: &[SettingKey],
    entity: Option<Uuid>,
    as_of: Timestamp,
) -> Result<ResolvedSettings, KernelError> {
    let rows = load_rows_in_tx(conn, org, keys, entity).await?;
    Ok(keys
        .iter()
        .map(|key| {
            let rows = rows.get(key).map_or(&[][..], Vec::as_slice);
            (*key, resolve(*key, rows, entity, as_of))
        })
        .collect())
}

/// Log a failed settings query and preserve the shared opaque error response.
pub fn db_error(error: sqlx::Error) -> KernelError {
    tracing::error!(error = %error, "settings query failed");
    KernelError::internal("internal server error")
}
