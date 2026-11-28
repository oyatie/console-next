//! ADR-006 shared settings reads on the caller's armed transaction.
use std::collections::BTreeMap;

use console_kernel_core::{KernelError, OrgId, Resolved, SettingVersionId, Timestamp};
use console_settings_domain::{Governance, OverrideRow, SettingError, resolve_chain};
pub use console_settings_domain::{SettingKey, SettingValue};
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
    Department,
    Person,
}

impl SettingLayerKind {
    #[must_use]
    pub fn from_db_layer(raw: &str) -> Option<Self> {
        match raw {
            "legal_entity" => Some(Self::LegalEntity),
            "workplace" => Some(Self::Workplace),
            "department" => Some(Self::Department),
            "person" => Some(Self::Person),
            _ => None,
        }
    }
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
/// and the scope chain (workplace, then its legal entity), plus platform rows.
/// Returns the chain beside the rows on the caller's armed
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
    load_scoped_rows_in_tx(conn, org, keys, entity, false).await
}

/// Historical document retention can resolve settings for archived workplaces and legal entities.
///
/// # Errors
/// As [`load_rows_in_tx`].
pub async fn load_scoped_rows_in_tx(
    conn: &mut PgConnection,
    org: OrgId,
    keys: &[SettingKey],
    entity: Option<Uuid>,
    include_archived: bool,
) -> Result<(Vec<SettingScope>, BTreeMap<SettingKey, Vec<OverrideRow>>), KernelError> {
    let wire: Vec<&str> = keys.iter().map(|k| k.as_str()).collect();
    let platform_keys: Vec<&str> = keys
        .iter()
        .filter(|key| key.def().governance == Governance::PlatformOnly)
        .map(|key| key.as_str())
        .collect();
    let scope_rows = if let Some(target_id) = entity {
        let mut fetched =
            sqlx::query("SELECT scope_id, layer FROM setting_scope_chain($1, $2) ORDER BY seq")
                .bind(org.as_uuid())
                .bind(target_id)
                .fetch_all(&mut *conn)
                .await
                .map_err(db_error)?;
        if fetched.is_empty() && include_archived {
            fetched = sqlx::query(
                "WITH target AS (
                    SELECT w.id AS workplace, e.id AS entity FROM workplaces w
                      JOIN legal_entities e ON e.org_id=w.org_id AND e.id=w.legal_entity_id
                     WHERE w.org_id=$1 AND w.id=$2
                    UNION ALL
                    SELECT NULL::uuid, e.id FROM legal_entities e WHERE e.org_id=$1 AND e.id=$2
                    ORDER BY workplace NULLS LAST LIMIT 1
                 )
                 SELECT scope_id, layer FROM target
                   CROSS JOIN LATERAL (VALUES (1, workplace, 'workplace'), (2, entity, 'legal_entity'))
                      AS scopes(seq, scope_id, layer)
                  WHERE scope_id IS NOT NULL ORDER BY seq",
            )
            .bind(org.as_uuid())
            .bind(target_id)
            .fetch_all(&mut *conn)
            .await
            .map_err(db_error)?;
        }
        if fetched.is_empty() {
            tracing::warn!(code = "setting_scope_unknown", "settings scope refused");
            return Err(KernelError::validation("unknown setting scope")
                .with_code("setting_scope_unknown")
                .with_field("scope_entity_id"));
        }
        fetched
    } else {
        Vec::new()
    };
    let mut chain = Vec::with_capacity(scope_rows.len());
    for srow in scope_rows {
        let id: Uuid = srow.try_get("scope_id").map_err(db_error)?;
        let raw_layer: String = srow.try_get("layer").map_err(db_error)?;
        let layer = SettingLayerKind::from_db_layer(&raw_layer)
            .ok_or_else(|| KernelError::internal("unknown setting scope layer"))?;
        chain.push(SettingScope { id, layer });
    }
    let chain_ids: Vec<Uuid> = chain.iter().map(|s| s.id).collect();
    let rows = sqlx::query(
        "SELECT id, key, scope_entity_id, value, effective_from
           FROM tenant_setting_overrides
          WHERE org_id = $1 AND key = ANY($2) AND NOT key = ANY($4)
            AND (scope_entity_id IS NULL OR scope_entity_id = ANY($3))
         UNION ALL
         SELECT id, key, NULL::uuid AS scope_entity_id, value, effective_from
           FROM platform_setting_overrides WHERE key = ANY($4)
          ORDER BY effective_from",
    )
    .bind(org.as_uuid())
    .bind(&wire)
    .bind(&chain_ids)
    .bind(&platform_keys)
    .fetch_all(&mut *conn)
    .await
    .map_err(db_error)?;
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
