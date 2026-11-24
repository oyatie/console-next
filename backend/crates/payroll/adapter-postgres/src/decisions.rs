use super::*;

pub async fn submit_run_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
    actor: Uuid,
) -> Result<(), LifecycleError> {
    let Some(run) = run_head(tx, run_id, true).await? else {
        return Err(LifecycleError::NotFound);
    };
    if run.status != "CALCULATED" {
        return Err(invalid_state("submit", &run.status));
    }
    let (open, _) = exception_counts_in_tx(tx, run_id).await?;
    if open > 0 {
        return Err(LifecycleError::ExceptionsOpen(open));
    }
    let calculated: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM payroll_line_calculations WHERE run_id = $1)",
    )
    .bind(run_id)
    .fetch_one(tx.as_mut())
    .await?;
    if !calculated {
        return Err(LifecycleError::NothingCalculated);
    }
    sqlx::query(
        "UPDATE payroll_draft_runs \
         SET status = 'SUBMITTED', submitted_by = $2, submitted_at = now(), updated_at = now() \
         WHERE id = $1",
    )
    .bind(run_id)
    .bind(actor)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

pub async fn decide_run_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
    actor: Uuid,
    decision: &str,
    reason: Option<&str>,
) -> Result<(), LifecycleError> {
    let Some(run) = run_head(tx, run_id, true).await? else {
        return Err(LifecycleError::NotFound);
    };
    if run.status != "SUBMITTED" {
        return Err(invalid_state("decide", &run.status));
    }
    if let Some(refusal) =
        console_platform_authz::cedar_pbac::actions::independent_people::refusal_in_tx(
            tx.as_mut(),
            run.submitted_by,
            actor,
        )
        .await
    {
        return Err(match refusal {
            console_platform_authz::cedar_pbac::actions::independent_people::Refusal::IdentityUnbound => LifecycleError::IdentityUnbound,
            console_platform_authz::cedar_pbac::actions::independent_people::Refusal::SamePerson => LifecycleError::SodViolation,
        });
    }
    match decision {
        "APPROVE" => {
            sqlx::query(
                "UPDATE payroll_draft_runs \
                 SET status = 'APPROVED', decided_by = $2, decided_at = now(), \
                     decision_reason = $3, approved_by = $2, approved_at = now(), \
                     updated_at = now() \
                 WHERE id = $1",
            )
            .bind(run_id)
            .bind(actor)
            .bind(reason)
            .execute(tx.as_mut())
            .await?;
        }
        "REJECT" => {
            if reason.is_none_or(|r| r.trim().is_empty()) {
                return Err(LifecycleError::Validation(
                    "a reason is required to reject a payroll run".to_owned(),
                ));
            }
            sqlx::query(
                "UPDATE payroll_draft_runs \
                 SET status = 'REJECTED', decided_by = $2, decided_at = now(), \
                     decision_reason = $3, updated_at = now() \
                 WHERE id = $1",
            )
            .bind(run_id)
            .bind(actor)
            .bind(reason)
            .execute(tx.as_mut())
            .await?;
        }
        other => {
            return Err(LifecycleError::Validation(format!(
                "unknown decision: {other}"
            )));
        }
    }
    Ok(())
}
