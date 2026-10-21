//! IMPORT-2 (decisions #25): the 사번 facts a numbering, a change or a
//! renumbering reads — the numbers in use (every record's, voided ones too,
//! and every live alias), the tenant's rules, and each 사업장's 법인.

use std::collections::{BTreeMap, BTreeSet};

use console_hr_domain::import::numbering::{NumberRule, Numbering};
use console_ontology_canonical_adapter_postgres::employee_void::include_voided;
use console_settings_domain::{SettingKey, SettingValue};
use sqlx::Postgres;
use uuid::Uuid;

use crate::HrError;
use crate::import::caps::settings_in_tx;

type Tx<'a, 'b> = &'a mut sqlx::Transaction<'b, Postgres>;

/// Serializes every 사번 writer of the tenant (the registration's own lock).
pub async fn lock_numbers(tx: Tx<'_, '_>, org: Uuid) -> Result<(), HrError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('employee_number_seq:' || $1::text))")
        .bind(org)
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

/// Every 사번 in use: current numbers (voided records included, MR-26 never
/// reuses them) and live aliases.
pub async fn taken_numbers(tx: Tx<'_, '_>, org: Uuid) -> Result<BTreeSet<String>, HrError> {
    include_voided(tx, true).await?;
    let current: Vec<String> = sqlx::query_scalar(
        "SELECT employee_number FROM employees WHERE org_id = $1 \
           AND employee_number IS NOT NULL AND btrim(employee_number) <> ''",
    )
    .bind(org)
    .fetch_all(tx.as_mut())
    .await?;
    include_voided(tx, false).await?;
    let aliases: Vec<String> = sqlx::query_scalar(
        "SELECT from_number FROM employee_number_changes \
          WHERE org_id = $1 AND undone_at IS NULL AND from_number IS NOT NULL",
    )
    .bind(org)
    .fetch_all(tx.as_mut())
    .await?;
    Ok(current.into_iter().chain(aliases).collect())
}

/// The rule rows as `(scope kind, scope id, rule)`.
pub async fn rule_rows(
    tx: Tx<'_, '_>,
    org: Uuid,
) -> Result<Vec<(String, Uuid, NumberRule)>, HrError> {
    let rows: Vec<(String, Uuid, String, i16)> = sqlx::query_as(
        "SELECT scope_kind, scope_id, prefix, width FROM employee_number_rules \
          WHERE org_id = $1 ORDER BY scope_kind, scope_id",
    )
    .bind(org)
    .fetch_all(tx.as_mut())
    .await?;
    Ok(rows
        .into_iter()
        .map(|(kind, id, prefix, width)| {
            let width = u8::try_from(width).unwrap_or(6);
            (kind, id, NumberRule { prefix, width })
        })
        .collect())
}

/// Everything a plan needs to number new people.
pub async fn numbering(tx: Tx<'_, '_>, org: Uuid) -> Result<Numbering, HrError> {
    let key = SettingKey::ImportEmployeeNumberUnnumbered;
    let mode = settings_in_tx(tx, org, &[key]).await?;
    let mut out = Numbering {
        assign: mode.get(&key).and_then(|v| SettingValue::as_code(*v)) == Some("assign_by_rule"),
        ..Numbering::default()
    };
    for (kind, id, rule) in rule_rows(tx, org).await? {
        match kind.as_str() {
            "TENANT" => out.tenant = Some(rule),
            "LEGAL_ENTITY" => {
                out.by_entity.insert(id, rule);
            }
            _ => {
                out.by_workplace.insert(id, rule);
            }
        }
    }
    let places: Vec<(Uuid, Uuid)> =
        sqlx::query_as("SELECT id, legal_entity_id FROM workplaces WHERE org_id = $1")
            .bind(org)
            .fetch_all(tx.as_mut())
            .await?;
    out.workplace_entity = places.into_iter().collect::<BTreeMap<_, _>>();
    out.taken = taken_numbers(tx, org).await?;
    Ok(out)
}
