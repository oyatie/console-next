//! HrService::apply_due: the scheduled lifecycle runner's one call (moved
//! verbatim from `app/src/hr.rs`, R2-life). `app/src/lifecycle_schedule.rs`
//! owns the loop.

use std::collections::BTreeSet;

use console_hr_domain::lifecycle::classification::classification_columns;
use console_hr_domain::lifecycle::event::NormalizedEmployeeLifecycleTransition;
use console_kernel_core::{AuditEvent, OrgId, UserId};
use console_ontology_canonical_adapter_postgres::employment;
use console_platform_db::{with_audits, with_org_conn};
use serde_json::{Value, json};
use sqlx::Postgres;
use time::Date;
use uuid::Uuid;

use super::audit::scheduled_lifecycle_audit;
use super::classification::resolve_kept_status;
use super::hooks::LIFECYCLE_HOOKS;
use super::prepare::resolve_lifecycle_target;
use super::record::{apply_lifecycle_head, promote_from_title};
use super::rules::validate_lifecycle_transition;
use super::store::load_employee_for_lifecycle;
use crate::{HrError, HrService};

impl HrService {
    /// Applies the SCHEDULED events whose date has come (`effective_date <=
    /// today`, the org-local KST date the caller passes) in every tenant, oldest
    /// date first. Each event commits in its own audited transaction: re-validated
    /// against the live employee by the rules that admitted it, then APPLIED (the
    /// employee changes, `employee.lifecycle.apply`) or, when it is no longer
    /// valid, APPLY_FAILED with the refusal (`employee.lifecycle.apply_failed`).
    /// A server fault leaves it SCHEDULED for the next run. Idempotent and safe
    /// to run from several processes at once (rows are claimed with SKIP LOCKED).
    /// Returns how many events left SCHEDULED.
    pub async fn apply_due(&self, today: Date) -> Result<usize, String> {
        let pool = &self.pool;
        let orgs: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM platform_list_organizations()")
            // rls-arming: ok platform_list_organizations() is the SECURITY DEFINER id-only tenant discovery; every per-org statement below runs under with_org_conn / with_audits
            .fetch_all(pool)
            .await
            .map_err(|error| error.to_string())?;
        let today = today.to_string();
        let mut settled = 0;
        // One tenant's fault never stalls the others: it is logged and retried on
        // the next run.
        for org_uuid in orgs {
            let org = OrgId::from_uuid(org_uuid);
            let today = today.clone();
            let due: Vec<(Uuid, Uuid)> =
                match with_org_conn::<_, _, HrError>(pool, org, move |tx| {
                    Box::pin(async move {
                        Ok(sqlx::query_as(
                            "SELECT id, employee_id FROM employee_lifecycle_events \
                     WHERE org_id = $1 AND state = 'SCHEDULED' AND effective_date <= $2 \
                     ORDER BY effective_date, created_at LIMIT 500",
                        )
                        .bind(org_uuid)
                        .bind(today)
                        .fetch_all(tx.as_mut())
                        .await?)
                    })
                })
                .await
                {
                    Ok(due) => due,
                    Err(error) => {
                        tracing::warn!(
                            org = %org,
                            error = %error.message,
                            "scheduled lifecycle events could not be listed; retrying next run"
                        );
                        continue;
                    }
                };
            // An employee whose event stayed SCHEDULED on a server fault keeps
            // their later events for the next run too, so they apply in date order.
            let mut held: BTreeSet<Uuid> = BTreeSet::new();
            for (event_id, employee_id) in due {
                if held.contains(&employee_id) {
                    continue;
                }
                let applied = with_audits::<_, _, HrError>(pool, org, |tx| {
                    Box::pin(async move {
                        let audit =
                            apply_scheduled_lifecycle_event_tx(tx, org, employee_id, event_id)
                                .await?;
                        Ok((audit.is_some(), audit.into_iter().collect()))
                    })
                })
                .await;
                match applied {
                    Ok(true) => settled += 1,
                    Ok(false) => {}
                    Err(error) if error.status.is_client_error() => {
                        let failed = with_audits::<_, _, HrError>(pool, org, |tx| {
                            Box::pin(async move {
                                let audit = fail_scheduled_lifecycle_event_tx(
                                    tx,
                                    org,
                                    event_id,
                                    error.code,
                                    &error.message,
                                )
                                .await?;
                                Ok((audit.is_some(), audit.into_iter().collect()))
                            })
                        })
                        .await;
                        match failed {
                            Ok(failed) => settled += usize::from(failed),
                            Err(error) => {
                                held.insert(employee_id);
                                tracing::warn!(
                                    org = %org,
                                    lifecycle_event_id = %event_id,
                                    error = %error.message,
                                    "scheduled lifecycle refusal could not be recorded; retrying next run"
                                );
                            }
                        }
                    }
                    Err(error) => {
                        held.insert(employee_id);
                        tracing::warn!(
                            org = %org,
                            lifecycle_event_id = %event_id,
                            error = %error.message,
                            "scheduled lifecycle event apply failed; retrying next run"
                        );
                    }
                }
            }
        }
        Ok(settled)
    }
}

/// Applies one due SCHEDULED event; `None` when it is no longer SCHEDULED or
/// another runner holds it. Locks the employee before the event (the order
/// scheduling and cancelling use).
async fn apply_scheduled_lifecycle_event_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: OrgId,
    employee_id: Uuid,
    event_id: Uuid,
) -> Result<Option<AuditEvent>, HrError> {
    let org_uuid = *org.as_uuid();
    let current = load_employee_for_lifecycle(tx, org_uuid, employee_id).await?;
    let request: Option<(Option<Value>, Uuid)> = sqlx::query_as(
        "SELECT scheduled_request, created_by FROM employee_lifecycle_events \
         WHERE org_id = $1 AND id = $2 AND state = 'SCHEDULED' FOR UPDATE SKIP LOCKED",
    )
    .bind(org_uuid)
    .bind(event_id)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some((request, recorded_by)) = request else {
        return Ok(None);
    };
    let mut transition: NormalizedEmployeeLifecycleTransition = request
        .and_then(|request| serde_json::from_value(request).ok())
        .ok_or_else(|| HrError::internal("scheduled lifecycle event has no readable request"))?;
    // A renewal, APPOINT or 전환 keeps whatever status the employee holds on its date.
    resolve_kept_status(&mut transition, &current);
    validate_lifecycle_transition(&current, &transition)?;
    let target = resolve_lifecycle_target(tx, org_uuid, employee_id, &current, &transition).await?;
    // The from_ side is the head the event met on its date (0246, 0266), so
    // a rescission restores what was really there.
    let from = classification_columns(&current, &transition);
    sqlx::query(
        "UPDATE employee_lifecycle_events SET state = 'APPLIED', applied_at = now(), \
         from_status = $3, to_status = $4, from_company = $5, to_company = $6, \
         from_org_unit = $7, to_org_unit = $8, from_position = $9, to_position = $10, \
         from_org_unit_id = $11, from_job_title_id = $12, from_grade_id = $13, \
         from_position_kind_id = $14, from_job_id = $15, from_job_family_id = $16, \
         from_job = $17, from_employment_type = $18, from_contract_start_date = $19, \
         from_contract_end_date = CASE WHEN event_type IN \
           ('CONTRACT_RENEWAL', 'EMPLOYMENT_TYPE_CHANGE') THEN $20 END \
         WHERE org_id = $1 AND id = $2",
    )
    .bind(org_uuid)
    .bind(event_id)
    .bind(&current.employment_status)
    .bind(&transition.to_status)
    .bind(&current.company)
    .bind(&target.company)
    .bind(current.org_unit.as_deref())
    .bind(target.org_unit.as_deref())
    .bind(current.position.as_deref())
    .bind(target.position.as_deref())
    .bind(current.org_unit_id)
    .bind(promote_from_title(&current, &transition))
    .bind(from.from_grade_id)
    .bind(from.from_position_kind_id)
    .bind(from.from_job_id)
    .bind(from.from_job_family_id)
    .bind(from.from_job)
    .bind(from.from_employment_type)
    .bind(from.from_contract_start_date)
    .bind(current.contract_end_date)
    .execute(tx.as_mut())
    .await?;
    apply_lifecycle_head(
        tx,
        &LIFECYCLE_HOOKS,
        org_uuid,
        event_id,
        recorded_by,
        employee_id,
        &transition,
        &target,
    )
    .await?;
    // BW-19: a PRE_HIRE registration deferred its canonical employment to
    // this ONBOARD; it opens now, on behalf of the person who registered.
    if transition.event_type == "ONBOARD" {
        employment::appoint_legacy_head_in_tx(tx, org, UserId::from_uuid(recorded_by), employee_id)
            .await?;
    }
    Ok(Some(scheduled_lifecycle_audit(
        org,
        "employee.lifecycle.apply",
        employee_id,
        json!({
            "lifecycle_event_id": event_id,
            "event_type": &transition.event_type,
            "effective_date": &transition.effective_date,
            "from_status": &current.employment_status,
            "to_status": &transition.to_status,
        }),
    )?))
}

/// Marks a due SCHEDULED event APPLY_FAILED with the refusal it met on its
/// date; `None` when it already left SCHEDULED.
async fn fail_scheduled_lifecycle_event_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: OrgId,
    event_id: Uuid,
    failure_code: &str,
    failure_reason: &str,
) -> Result<Option<AuditEvent>, HrError> {
    let row: Option<(Uuid, String, String)> = sqlx::query_as(
        "UPDATE employee_lifecycle_events \
         SET state = 'APPLY_FAILED', failure_code = $3, failure_reason = $4 \
         WHERE org_id = $1 AND id = $2 AND state = 'SCHEDULED' \
         RETURNING employee_id, event_type, effective_date",
    )
    .bind(*org.as_uuid())
    .bind(event_id)
    .bind(failure_code)
    .bind(failure_reason)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some((employee_id, event_type, effective_date)) = row else {
        return Ok(None);
    };
    metrics::counter!("hr_scheduled_lifecycle_apply_failed_total", "event_type" => event_type.clone())
        .increment(1);
    Ok(Some(scheduled_lifecycle_audit(
        org,
        "employee.lifecycle.apply_failed",
        employee_id,
        json!({
            "lifecycle_event_id": event_id,
            "event_type": event_type,
            "effective_date": effective_date,
            "failure_code": failure_code,
            "failure_reason": failure_reason,
        }),
    )?))
}
