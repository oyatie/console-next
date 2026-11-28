// SPDX-License-Identifier: LicenseRef-Proprietary
use serde::Deserialize;
use sqlx::{Postgres, Transaction};
use time::Date;
use uuid::Uuid;

pub(crate) fn expected_month<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    let month = String::deserialize(deserializer)?;
    let date = format!("{month}-01");
    if month.len() != 7
        || Date::parse(
            &date,
            time::macros::format_description!("[year]-[month]-[day]"),
        )
        .is_err()
    {
        return Err(serde::de::Error::custom(
            "expected a payroll month in YYYY-MM format",
        ));
    }
    Ok(Some(month))
}

/// Returns `true` when `legal_entity_id` has more than one pay group in `org_id`
/// AND at least one active employee of that entity overlapping `[period_start, period_end]`
/// lacks an active `employee_pay_group_assignments` row (or zero assignments exist in the entity).
pub(crate) async fn entity_roster_ambiguous_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    legal_entity_id: Uuid,
    pay_group_id: Uuid,
    period_start: Date,
    period_end: Date,
) -> Result<bool, sqlx::Error> {
    let shared: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM pay_groups WHERE org_id=$1 AND legal_entity_id=$2 AND id<>$3)",
    )
    .bind(org_id)
    .bind(legal_entity_id)
    .bind(pay_group_id)
    .fetch_one(tx.as_mut())
    .await?;
    if !shared {
        return Ok(false);
    }
    let has_any_assignment: bool = sqlx::query_scalar(
        "SELECT EXISTS (
             SELECT 1 FROM employee_pay_group_assignments pga
             JOIN pay_groups pg2 ON pg2.org_id = pga.org_id AND pg2.id = pga.pay_group_id
             WHERE pga.org_id = $1 AND pg2.legal_entity_id = $2 AND pga.superseded_at IS NULL
         )",
    )
    .bind(org_id)
    .bind(legal_entity_id)
    .fetch_one(tx.as_mut())
    .await?;
    if !has_any_assignment {
        return Ok(true);
    }
    sqlx::query_scalar(
        "SELECT EXISTS (
             SELECT 1 FROM employees em
             WHERE em.org_id = $1
               AND em.merged_into_employee_id IS NULL AND em.employment_status <> 'VOIDED'
               AND (em.hire_on IS NULL OR em.hire_on <= LEAST($4, entity_today()))
               AND (em.exit_on IS NULL OR em.exit_on >= $3)
               AND NOT (em.employment_status = 'EXITED' AND em.exit_on IS NULL)
               AND EXISTS (
                   SELECT 1 FROM employment_assignments ea
                   WHERE ea.org_id = em.org_id AND ea.employee_id = em.id AND ea.superseded_at IS NULL
                     AND ea.legal_entity_id = $2
                     AND ea.valid_from <= $4 AND (ea.valid_to IS NULL OR ea.valid_to > $3)
               )
               AND NOT EXISTS (
                   SELECT 1 FROM employee_pay_group_assignments pga
                   JOIN pay_groups pg2 ON pg2.org_id = pga.org_id AND pg2.id = pga.pay_group_id
                   WHERE pga.org_id = em.org_id AND pga.employee_id = em.id
                     AND pg2.legal_entity_id = $2 AND pga.superseded_at IS NULL
                     AND pga.effective_from <= LEAST($4, em.exit_on)
                     AND (pga.effective_to_exclusive IS NULL OR pga.effective_to_exclusive > GREATEST($3, em.hire_on))
               )
         )",
    )
    .bind(org_id)
    .bind(legal_entity_id)
    .bind(period_start)
    .bind(period_end)
    .fetch_one(tx.as_mut())
    .await
}
