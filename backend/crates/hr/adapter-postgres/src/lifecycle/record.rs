//! Records a prepared lifecycle event and applies its effect on the employee.

use console_hr_application::lifecycle::hooks::LifecycleApplyHooks;
use console_hr_domain::lifecycle::event::{
    EmployeeForLifecycle, NormalizedEmployeeLifecycleTransition,
};
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::{
    AuditAction, AuditClassification, AuditEvent, ChangeMode, OrgId, TraceContext, UserId,
};
use console_ontology_canonical_adapter_postgres::{employment, employment_job_title};
use serde_json::json;
use sqlx::{PgConnection, Postgres};
use time::OffsetDateTime;
use uuid::Uuid;

use super::classification::apply_classification;
use super::hooks::{LIFECYCLE_HOOKS, apply_event, rescinded};
use super::insert::insert_lifecycle_row;
use super::placement::apply_move;
use super::prepare::{LifecycleTarget, PreparedLifecycleEvent};
use super::rows::employee_lifecycle_event_from_row;
use super::types::EmployeeLifecycleEventResponse;
use crate::HrError;
use crate::lifecycle_event_select;
use crate::own_record::own_record_guard;
use console_platform_authz::Feature;

/// Writes an event's effect on the employee: the Employment head, a unit
/// rebind, and (CONTRACT_RENEWAL) the profile's current contract end, between
/// the `before_apply` and `after_apply` hooks (C8), and (E-S3b) the
/// assignment split of a 전근, written as `actor`. A hook's `Err` is returned
/// as is; the caller's transaction then rolls the whole event back.
#[allow(clippy::too_many_arguments)]
pub async fn apply_lifecycle_head<H: LifecycleApplyHooks<PgConnection>>(
    tx: &mut sqlx::Transaction<'_, Postgres>,
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
        .before_apply(tx.as_mut(), &hook_event)
        .await
        .map_err(super::title_reason::coded)?;
    // The Employment owner's statement, inside this transaction. See
    // [`create_employee_core`] for why the DML is not held here.
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
    // BW-11: every lifecycle change moves the version pin.
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
    // A renewal moves the contract's current end (the queue reads it there).
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
        .after_apply(tx.as_mut(), &hook_event)
        .await
        .map_err(super::title_reason::coded)
}

/// Records one already-prepared lifecycle event inside the caller's
/// transaction and returns it with its audit. An immediate event is APPLIED:
/// the ledger row plus its effect on the employee. A scheduled one (dated
/// after today, KST) is stored SCHEDULED with its request, replacing a
/// SCHEDULED event of the same kind on the same date (a correction), and
/// changes nothing else until its date. Shared by the single-event, bulk, and
/// exit-confirmation paths so all apply exactly the same effect.
pub async fn record_lifecycle_event_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    employee_id: Uuid,
    prepared: &PreparedLifecycleEvent,
    batch_id: Option<Uuid>,
) -> Result<(EmployeeLifecycleEventResponse, AuditEvent), HrError> {
    // people-self-33: every recorded event (single, bulk, correction, change
    // set, the exit's TERMINATE) meets the self rule here, once.
    own_record_guard(
        tx,
        org,
        actor,
        employee_id,
        Feature::EmployeeDirectoryManage,
    )
    .await?;
    let org_uuid = *org.as_uuid();
    let PreparedLifecycleEvent {
        transition,
        target,
        scheduled,
        replaces,
        replace_reason_code,
        change_mode,
        ..
    } = prepared;
    let scheduled = *scheduled;
    let lifecycle_id = Uuid::new_v4();
    // The replaced event is the one preparation chose: never an exit case's.
    let superseded: Option<Uuid> = match replaces {
        Some(replaced) => {
            sqlx::query_scalar(
                "UPDATE employee_lifecycle_events \
                 SET state = 'CANCELLED', cancelled_by = $3, cancelled_at = now(), superseded_by = $4, \
                     cancel_reason_code = $5 \
                 WHERE org_id = $1 AND id = $2 AND state = 'SCHEDULED' \
                 RETURNING id",
            )
            .bind(org_uuid)
            .bind(replaced)
            .bind(*actor.as_uuid())
            .bind(lifecycle_id)
            .bind(replace_reason_code.as_deref())
            .fetch_optional(tx.as_mut())
            .await?
        }
        None => None,
    };
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new(if scheduled {
            "employee.lifecycle.schedule"
        } else {
            "employee.lifecycle.record"
        })
        .map_err(HrError::from_kernel)?,
        "employee",
        employee_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(json!({
            "lifecycle_event_id": lifecycle_id,
            "employee_id": employee_id,
            "event_type": &transition.event_type,
            "to_status": &transition.to_status,
            "effective_date": &transition.effective_date,
            "state": if scheduled { "SCHEDULED" } else { "APPLIED" },
            "superseded_lifecycle_event_id": superseded,
            "batch_id": batch_id,
            "has_privacy_notice_ack": transition.signoffs.privacy_notice_ack,
            "has_korean_labor_law_ack": transition.signoffs.korean_labor_law_ack,
            "has_payroll_cutoff_ack": transition.signoffs.payroll_cutoff_ack,
            "has_retirement_settlement_ack": transition.signoffs.retirement_settlement_ack,
            "change_mode": change_mode.map(ChangeMode::as_str),
        })),
    )
    // A leave or transfer recorded in SETUP is a setup record (decisions #26):
    // the 운영 시작 preview counts it with the other setup writes.
    .with_classification(AuditClassification {
        badges: (*change_mode == Some(ChangeMode::Setup)).then(|| vec!["setup".to_owned()]),
        anomaly: None,
        reason: None,
    });
    let scheduled_request = if scheduled {
        Some(
            serde_json::to_value(transition)
                .map_err(|_| HrError::internal("scheduled request serialization failed"))?,
        )
    } else {
        None
    };

    insert_lifecycle_row(
        tx,
        (org_uuid, lifecycle_id, *actor.as_uuid(), batch_id),
        employee_id,
        prepared,
        scheduled_request,
    )
    .await?;

    if !scheduled {
        apply_lifecycle_head(
            tx,
            &LIFECYCLE_HOOKS,
            org_uuid,
            lifecycle_id,
            *actor.as_uuid(),
            employee_id,
            transition,
            target,
        )
        .await?;
    }

    let item = load_lifecycle_event(tx, org_uuid, lifecycle_id).await?;
    metrics::counter!("hr_employee_lifecycle_events_total", "event_type" => item.event_type.clone())
        .increment(1);
    Ok((item, event))
}

/// The title a PROMOTE leaves (stored for the 강등 audit and a rescind). The
/// runner rewrites it for a scheduled PROMOTE when it applies (0266).
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
        rescinded(tx.as_mut(), &event).await?;
    }
    Ok(())
}
