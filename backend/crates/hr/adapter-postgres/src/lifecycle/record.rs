//! Records a prepared lifecycle event and applies its effect on the employee.

use console_hr_application::lifecycle::hooks::LifecycleApplyHooks;
use console_hr_domain::lifecycle::event::{
    EmployeeForLifecycle, NormalizedEmployeeLifecycleTransition,
};
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::{AuditEvent, OrgId, UserId};
use console_ontology_canonical_adapter_postgres::{employment, employment_job_title};
use sqlx::Postgres;
use uuid::Uuid;

use super::classification::apply_classification;
use super::hooks::{LIFECYCLE_HOOKS, LifecycleTrailHooks, apply_event, rescinded};
use super::placement::apply_move;
use super::prepare::{LifecycleTarget, PreparedLifecycleEvent};
use super::rows::employee_lifecycle_event_from_row;
use super::types::EmployeeLifecycleEventResponse;
use crate::HrError;
use crate::lifecycle_event_select;

/// Transactional hooks wrap employee changes; any refusal rolls the whole event back.
#[allow(clippy::too_many_arguments)]
pub async fn apply_lifecycle_head<'c, H: LifecycleApplyHooks<sqlx::Transaction<'c, Postgres>>>(
    tx: &mut sqlx::Transaction<'c, Postgres>,
    hooks: &H,
    org_uuid: Uuid,
    event_id: Uuid,
    actor: Uuid,
    employee_id: Uuid,
    transition: &NormalizedEmployeeLifecycleTransition,
    target: &LifecycleTarget,
) -> Result<(), HrError> {
    let hook_event = apply_event(
        org_uuid,
        event_id,
        employee_id,
        &transition.event_type,
        &transition.effective_date,
    )?;
    hooks
        .before_apply(tx, &hook_event)
        .await
        .map_err(super::title_reason::coded)?;
    // The canonical Employment owner holds the employee DML.
    employment::apply_employment_change(
        tx,
        org_uuid,
        employee_id,
        employment::EmploymentChange {
            company: &target.company,
            org_unit: target.org_unit.as_deref(),
            position: target.position.as_deref(),
            employment_status: &transition.to_status,
            effective_date: &transition.effective_date,
        },
    )
    .await?;
    employment_job_title::bump_head_version(tx, org_uuid, employee_id).await?;
    if transition.event_type == "PROMOTE" {
        employment_job_title::set_employee_job_title(
            tx,
            org_uuid,
            employee_id,
            target.job_title_id,
        )
        .await?;
    }
    if let Some(binding) = target.rebind {
        employment::set_employee_org_unit(tx, org_uuid, employee_id, binding, None).await?;
    }
    if let Some(to) = target.workplace {
        let on = parse_yyyy_mm_dd(&transition.effective_date)?;
        // A 전적's assignments carry its event id as the group_transfer_id.
        let group = (transition.event_type == "GROUP_TRANSFER").then_some(event_id);
        apply_move(tx, (org_uuid, employee_id, actor), event_id, to, on, group).await?;
    }
    if let Some(contract_end_date) = transition.contract_end_date.as_deref() {
        sqlx::query(
            "UPDATE employee_employment_profiles SET contract_end_date = $3::DATE \
             WHERE org_id = $1 AND employee_id = $2",
        )
        .bind(org_uuid)
        .bind(employee_id)
        .bind(contract_end_date)
        .execute(tx.as_mut())
        .await?;
    }
    apply_classification(tx, org_uuid, employee_id, &transition.event_type, target).await?;
    hooks
        .after_apply(tx, &hook_event)
        .await
        .map_err(super::title_reason::coded)
}

/// Records one event and its audit using the default transactional hooks.
pub async fn record_lifecycle_event_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    employee_id: Uuid,
    prepared: &PreparedLifecycleEvent,
    batch_id: Option<Uuid>,
) -> Result<(EmployeeLifecycleEventResponse, AuditEvent), HrError> {
    record_lifecycle_event_with_hooks(
        tx,
        org,
        actor,
        employee_id,
        prepared,
        batch_id,
        &LIFECYCLE_HOOKS,
    )
    .await
}

/// A bulk action shares its loaded register through the caller's hooks.
pub async fn record_lifecycle_event_with_hooks(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    employee_id: Uuid,
    prepared: &PreparedLifecycleEvent,
    batch_id: Option<Uuid>,
    hooks: &LifecycleTrailHooks<'_>,
) -> Result<(EmployeeLifecycleEventResponse, AuditEvent), HrError> {
    let (id, audit) =
        super::record_write::record_in_tx(tx, org, actor, employee_id, prepared, batch_id, hooks)
            .await?;
    let item = load_lifecycle_event(tx, *org.as_uuid(), id).await?;
    metrics::counter!("hr_employee_lifecycle_events_total", "event_type" => item.event_type.clone()).increment(1);
    Ok((item, audit))
}

/// Captures the prior title for demotion audit and rescission, including scheduled apply.
pub fn promote_from_title(
    current: &EmployeeForLifecycle,
    transition: &NormalizedEmployeeLifecycleTransition,
) -> Option<Uuid> {
    current
        .job_title_id
        .filter(|_| transition.event_type == "PROMOTE")
}

pub async fn load_lifecycle_event(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    lifecycle_id: Uuid,
) -> Result<EmployeeLifecycleEventResponse, HrError> {
    let row = sqlx::query(lifecycle_event_select!("WHERE l.org_id = $1 AND l.id = $2"))
        .bind(org_uuid)
        .bind(lifecycle_id)
        .fetch_one(tx.as_mut())
        .await?;
    employee_lifecycle_event_from_row(row)
}

pub async fn cancel_scheduled_lifecycle_event_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    event_id: Uuid,
    actor: UserId,
    reason: &str,
) -> Result<(), HrError> {
    let cancelled: Option<(Uuid, String, String)> = sqlx::query_as(
        "UPDATE employee_lifecycle_events \
         SET state = 'CANCELLED', cancelled_by = $3, cancelled_at = now(), cancel_reason = $4 \
         WHERE org_id = $1 AND id = $2 AND state = 'SCHEDULED' \
         RETURNING employee_id, event_type, effective_date",
    )
    .bind(org_uuid)
    .bind(event_id)
    .bind(*actor.as_uuid())
    .bind(reason)
    .fetch_optional(tx.as_mut())
    .await?;
    if let Some((employee_id, event_type, effective_date)) = cancelled {
        let event = apply_event(
            org_uuid,
            event_id,
            employee_id,
            &event_type,
            &effective_date,
        )?;
        rescinded(tx, &event).await?;
    }
    Ok(())
}
