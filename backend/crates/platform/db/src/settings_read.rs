//! ADR-006 shared settings reads on the caller's armed transaction.
use std::collections::BTreeMap;

use console_kernel_core::{KernelError, OrgId, Resolved, SettingVersionId, Timestamp};
use console_settings_domain::{
    Governance, OverrideRow, SettingError, SettingKey, SettingValue, resolve_chain,
};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// The source of a value; scope kinds come from their owning tables.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingLayerKind {
    CodeDefault,
    Platform,
    Tenant,
    LegalEntity,
    Workplace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SettingScope {
    pub id: Uuid,
    pub layer: SettingLayerKind,
}

/// Resolved values of a key set, one `Result` per key (a tenant fact with no
/// row in force is `Err(FactUndeclared)`).
pub type ResolvedSettings = BTreeMap<SettingKey, Result<Resolved<SettingValue>, SettingError>>;

/// Every override row of `keys` for the armed tenant, at the tenant scope
/// and the scope chain (사업장, then its legal entity), plus platform rows. Returns the chain beside the rows on the caller's armed
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
) -> Result<(Vec<SettingScope>, BTreeMap<SettingKey, Vec<OverrideRow>>), KernelError> {
    let wire: Vec<&str> = keys.iter().map(|k| k.as_str()).collect();
    let platform_keys: Vec<&str> = keys
        .iter()
        .filter(|key| key.def().governance == Governance::PlatformOnly)
        .map(|key| key.as_str())
        .collect();
    let rows = sqlx::query(
        "WITH target AS (
           SELECT w.id AS workplace_id, e.id AS legal_entity_id
             FROM workplaces w JOIN legal_entities e ON e.org_id=w.org_id AND e.id=w.legal_entity_id
            WHERE w.org_id=$1 AND w.id=$3
           UNION ALL
           SELECT NULL::uuid, e.id FROM legal_entities e WHERE e.org_id=$1 AND e.id=$3
           ORDER BY workplace_id NULLS LAST LIMIT 1
         ), scope AS (
           SELECT t.workplace_id, t.legal_entity_id,
             CASE WHEN $3::uuid IS NULL THEN '{}'::uuid[]
                  WHEN t.legal_entity_id IS NOT NULL THEN array_remove(ARRAY[t.workplace_id,t.legal_entity_id], NULL)
             END AS chain
           FROM (SELECT 1) anchor LEFT JOIN target t ON true
         ), overrides AS (
         SELECT id, key, scope_entity_id, value, effective_from
           FROM tenant_setting_overrides
          WHERE org_id = $1 AND key = ANY($2) AND NOT key = ANY($4)
            AND (scope_entity_id IS NULL OR scope_entity_id = ANY((SELECT chain FROM scope)::uuid[]))
          UNION ALL
         SELECT id, key, NULL::uuid, value, effective_from
           FROM platform_setting_overrides WHERE key = ANY($4)
         ) SELECT scope.chain, scope.workplace_id, scope.legal_entity_id, o.* FROM scope LEFT JOIN overrides o ON true
          ORDER BY effective_from",
    )
    .bind(org.as_uuid())
    .bind(&wire)
    .bind(entity)
    .bind(&platform_keys)
    .fetch_all(conn)
    .await
    .map_err(db_error)?;
    let scope = rows
        .first()
        .ok_or_else(|| KernelError::internal("settings scope query returned no row"))?;
    let ids: Option<Vec<Uuid>> = scope.try_get("chain").map_err(db_error)?;
    if ids.is_none() {
        tracing::warn!(code = "setting_scope_unknown", "settings scope refused");
        return Err(KernelError::validation("unknown setting scope")
            .with_code("setting_scope_unknown")
            .with_field("scope_entity_id"));
    }
    let workplace: Option<Uuid> = scope.try_get("workplace_id").map_err(db_error)?;
    let legal_entity: Option<Uuid> = scope.try_get("legal_entity_id").map_err(db_error)?;
    let chain = [
        (workplace, SettingLayerKind::Workplace),
        (legal_entity, SettingLayerKind::LegalEntity),
    ]
    .into_iter()
    .filter_map(|(id, layer)| id.map(|id| SettingScope { id, layer }))
    .collect();
    let mut out: BTreeMap<SettingKey, Vec<OverrideRow>> = BTreeMap::new();
    for row in rows {
        let Some(wire_key): Option<String> = row.try_get("key").map_err(db_error)? else {
            continue;
        };
        let Ok(key) = wire_key.parse::<SettingKey>() else {
            continue;
        };
        let raw: serde_json::Value = row.try_get("value").map_err(db_error)?;
        let value = key
            .def()
            .parse(&raw)
            .filter(|value| key.def().in_range(*value))
            .ok_or_else(|| {
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
    Ok((chain, out))
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
    let (chain, rows) = load_rows_in_tx(conn, org, keys, entity).await?;
    Ok(keys
        .iter()
        .map(|key| {
            let rows = rows.get(key).map_or(&[][..], Vec::as_slice);
            (*key, resolve_loaded(*key, rows, &chain, as_of))
        })
        .collect())
}

/// Resolve rows loaded by `load_rows_in_tx`; platform keys contain only operator-owned rows.
/// # Errors
/// An undeclared tenant fact, as in the domain resolver.
pub fn resolve_loaded(
    key: SettingKey,
    rows: &[OverrideRow],
    chain: &[SettingScope],
    as_of: Timestamp,
) -> Result<Resolved<SettingValue>, SettingError> {
    if key.def().governance == Governance::PlatformOnly
        && let Some(row) = rows
            .iter()
            .filter(|row| row.scope_entity_id.is_none() && row.effective_from <= as_of)
            .max_by_key(|row| row.effective_from)
    {
        return Ok(Resolved {
            value: row.value,
            version: SettingVersionId::Override(row.id),
        });
    }
    tracing::debug_span!("resolve_chain", chain_length = chain.len()).in_scope(|| {
        resolve_chain(
            key,
            rows,
            &chain.iter().map(|scope| scope.id).collect::<Vec<_>>(),
            as_of,
        )
    })
}

/// Log a failed settings query and preserve the shared opaque error response.
pub fn db_error(error: sqlx::Error) -> KernelError {
    tracing::error!(error = %error, "settings query failed");
    KernelError::internal("internal server error")
}
