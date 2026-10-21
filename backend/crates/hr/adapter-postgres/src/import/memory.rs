//! IMPORT-2 (decisions #25): what a tenant mapped once is offered again —
//! header labels → targets (`import_column_memory`, written when the
//! operator maps a sheet) and cell values → codes or records
//! (`import_value_memory`, written when a run is applied). The operator's
//! answer in a dry run always wins over memory; a remembered record that is
//! no longer usable (a dissolved unit, a closed 사업장) is dropped, not used.

use std::collections::BTreeMap;

use console_hr_domain::import::plan::Decisions;
use console_kernel_core::OrgId;
use console_platform_db::with_org_conn;
use sqlx::Postgres;
use uuid::Uuid;

use crate::{HrError, HrService};

impl HrService {
    /// The tenant's remembered header labels (memory key → target or none).
    pub async fn import_column_memory(
        &self,
        org: OrgId,
    ) -> Result<BTreeMap<String, Option<String>>, HrError> {
        with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let rows: Vec<(String, Option<String>)> = sqlx::query_as(
                    "SELECT header_key, target FROM import_column_memory WHERE org_id = $1",
                )
                .bind(*org.as_uuid())
                .fetch_all(tx.as_mut())
                .await?;
                Ok(rows.into_iter().collect())
            })
        })
        .await
    }
}

/// Upserts the labels the operator mapped.
pub async fn remember_columns(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    actor: Uuid,
    labels: &[(String, Option<String>)],
) -> Result<(), HrError> {
    for (key, target) in labels {
        sqlx::query(
            "INSERT INTO import_column_memory (org_id, header_key, target, updated_by) \
             VALUES ($1, $2, $3, $4) ON CONFLICT (org_id, header_key) \
             DO UPDATE SET target = EXCLUDED.target, updated_by = EXCLUDED.updated_by, updated_at = now()",
        )
        .bind(org)
        .bind(key)
        .bind(target)
        .bind(actor)
        .execute(tx.as_mut())
        .await?;
    }
    Ok(())
}

/// The value maps of `decisions` as `(field, source value, mapped)`.
fn value_rows(decisions: &Decisions) -> Vec<(&'static str, &String, Option<String>)> {
    let id = |v: &Option<Uuid>| v.map(|id| id.to_string());
    let units = decisions
        .unit_map
        .iter()
        .map(|(k, v)| ("org_unit", k, id(v)));
    let places = decisions
        .workplace_map
        .iter()
        .map(|(k, v)| ("workplace", k, id(v)));
    let kinds = decisions
        .employment_type_map
        .iter()
        .map(|(k, v)| ("employment_type", k, v.clone()));
    let statuses = decisions
        .status_map
        .iter()
        .map(|(k, v)| ("employment_status", k, Some(v.clone())));
    let leaves = decisions
        .leave_type_map
        .iter()
        .map(|(k, v)| ("leave_type", k, Some(v.clone())));
    units
        .chain(places)
        .chain(kinds)
        .chain(statuses)
        .chain(leaves)
        .filter(|(_, k, _)| k.chars().count() <= 200)
        .collect()
}

/// Upserts every value map an applied run used.
pub async fn remember_values(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    actor: Uuid,
    decisions: &Decisions,
) -> Result<(), HrError> {
    for (field, value, mapped) in value_rows(decisions) {
        sqlx::query(
            "INSERT INTO import_value_memory (org_id, field, source_value, mapped, updated_by) \
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (org_id, field, source_value) \
             DO UPDATE SET mapped = EXCLUDED.mapped, updated_by = EXCLUDED.updated_by, updated_at = now()",
        )
        .bind(org)
        .bind(field)
        .bind(value)
        .bind(mapped)
        .bind(actor)
        .execute(tx.as_mut())
        .await?;
    }
    Ok(())
}

/// The remembered value maps as decisions (record ids parsed; a malformed
/// row is skipped).
pub async fn remembered_values(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
) -> Result<Decisions, HrError> {
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT field, source_value, mapped FROM import_value_memory WHERE org_id = $1",
    )
    .bind(org)
    .fetch_all(tx.as_mut())
    .await?;
    let mut out = Decisions::default();
    let id = |v: &Option<String>| v.as_deref().map(Uuid::parse_str).transpose().ok();
    for (field, value, mapped) in rows {
        match field.as_str() {
            "org_unit" => {
                if let Some(id) = id(&mapped) {
                    out.unit_map.insert(value, id);
                }
            }
            "workplace" => {
                if let Some(id) = id(&mapped) {
                    out.workplace_map.insert(value, id);
                }
            }
            "employment_type" => {
                out.employment_type_map.insert(value, mapped);
            }
            "employment_status" => {
                out.status_map.extend(mapped.map(|m| (value, m)));
            }
            "leave_type" => {
                out.leave_type_map.extend(mapped.map(|m| (value, m)));
            }
            _ => {}
        }
    }
    Ok(out)
}

/// `operator` with the remembered entries it does not answer itself; the
/// second value lists which `(decision, key)` came from memory.
#[must_use]
pub fn merge(operator: &Decisions, memory: Decisions) -> (Decisions, Vec<(&'static str, String)>) {
    fn fill<V>(
        name: &'static str,
        into: &mut BTreeMap<String, V>,
        from: BTreeMap<String, V>,
        used: &mut Vec<(&'static str, String)>,
    ) {
        for (key, value) in from {
            if let std::collections::btree_map::Entry::Vacant(slot) = into.entry(key) {
                used.push((name, slot.key().clone()));
                slot.insert(value);
            }
        }
    }
    let mut out = operator.clone();
    let mut used = Vec::new();
    fill("unit_map", &mut out.unit_map, memory.unit_map, &mut used);
    fill(
        "workplace_map",
        &mut out.workplace_map,
        memory.workplace_map,
        &mut used,
    );
    fill(
        "employment_type_map",
        &mut out.employment_type_map,
        memory.employment_type_map,
        &mut used,
    );
    fill(
        "status_map",
        &mut out.status_map,
        memory.status_map,
        &mut used,
    );
    fill(
        "leave_type_map",
        &mut out.leave_type_map,
        memory.leave_type_map,
        &mut used,
    );
    (out, used)
}
