// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{Disbursement, LifecycleError, invalid_state, run_head};
use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

fn disbursement_from_row(row: &sqlx::postgres::PgRow) -> Result<Disbursement, LifecycleError> {
    Ok(Disbursement {
        id: row.try_get("id")?,
        run_id: row.try_get("run_id")?,
        scheduled_at: row.try_get("scheduled_at")?,
        status: row.try_get("status")?,
        attested_by: row.try_get("attested_by")?,
        attested_at: row.try_get("attested_at")?,
        reason: row.try_get("reason")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

pub async fn get_disbursement_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
) -> Result<Option<Disbursement>, LifecycleError> {
    let row = sqlx::query(
        "SELECT id, run_id, scheduled_at, status, attested_by, attested_at, reason, \
                created_at, updated_at \
         FROM payroll_disbursements WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_optional(tx.as_mut())
    .await?;
    row.as_ref().map(disbursement_from_row).transpose()
}

pub async fn schedule_disbursement_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
    scheduled_at: OffsetDateTime,
) -> Result<Disbursement, LifecycleError> {
    let Some(run) = run_head(tx, run_id, true).await? else {
        return Err(LifecycleError::NotFound);
    };
    if run.status != "APPROVED" {
        return Err(invalid_state("schedule disbursement for", &run.status));
    }
    let row = sqlx::query(
        "INSERT INTO payroll_disbursements (org_id, run_id, scheduled_at) \
         SELECT r.org_id, r.id, $2 FROM payroll_draft_runs r WHERE r.id = $1 \
         ON CONFLICT (run_id) DO NOTHING \
         RETURNING id, run_id, scheduled_at, status, attested_by, attested_at, reason, \
                   created_at, updated_at",
    )
    .bind(run_id)
    .bind(scheduled_at)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some(row) = row else {
        return Err(LifecycleError::InvalidState(
            "a disbursement is already scheduled for this run".to_owned(),
        ));
    };
    sqlx::query(
        "UPDATE payroll_draft_runs SET status = 'DISBURSEMENT_SCHEDULED', updated_at = now() \
         WHERE id = $1",
    )
    .bind(run_id)
    .execute(tx.as_mut())
    .await?;
    disbursement_from_row(&row)
}

pub async fn attest_disbursement_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
    actor: Uuid,
    new_status: &str,
    reason: Option<&str>,
) -> Result<Disbursement, LifecycleError> {
    let Some(run) = run_head(tx, run_id, true).await? else {
        return Err(LifecycleError::NotFound);
    };
    let row = sqlx::query(
        "SELECT id, run_id, scheduled_at, status, attested_by, attested_at, reason, \
                created_at, updated_at \
         FROM payroll_disbursements WHERE run_id = $1 FOR UPDATE",
    )
    .bind(run_id)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some(row) = row else {
        return Err(LifecycleError::InvalidState(
            "no disbursement is scheduled for this run".to_owned(),
        ));
    };
    let current = disbursement_from_row(&row)?;
    let allowed = matches!(
        (current.status.as_str(), new_status),
        ("SCHEDULED", "SUBMITTED_TO_BANK")
            | ("SUBMITTED_TO_BANK", "PAID")
            | ("SUBMITTED_TO_BANK", "FAILED")
            | ("FAILED", "SCHEDULED")
    );
    if !allowed {
        return Err(LifecycleError::InvalidTransition(format!(
            "cannot attest {new_status} from {}",
            current.status
        )));
    }
    if new_status == "FAILED" && reason.is_none_or(|r| r.trim().is_empty()) {
        return Err(LifecycleError::Validation(
            "a reason is required to attest a failed disbursement".to_owned(),
        ));
    }
    let row = sqlx::query(
        "UPDATE payroll_disbursements \
         SET status = $2, attested_by = $3, attested_at = now(), \
             reason = CASE WHEN $2 = 'FAILED' THEN $4 ELSE NULL END, updated_at = now() \
         WHERE run_id = $1 \
         RETURNING id, run_id, scheduled_at, status, attested_by, attested_at, reason, \
                   created_at, updated_at",
    )
    .bind(run_id)
    .bind(new_status)
    .bind(actor)
    .bind(reason)
    .fetch_one(tx.as_mut())
    .await?;
    if new_status == "PAID" {
        if run.status != "DISBURSEMENT_SCHEDULED" {
            return Err(invalid_state("mark paid", &run.status));
        }
        sqlx::query(
            "UPDATE payroll_draft_runs SET status = 'PAID', updated_at = now() WHERE id = $1",
        )
        .bind(run_id)
        .execute(tx.as_mut())
        .await?;
    }
    disbursement_from_row(&row)
}
