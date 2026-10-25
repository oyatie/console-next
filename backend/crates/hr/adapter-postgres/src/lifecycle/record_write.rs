// SPDX-License-Identifier: LicenseRef-Proprietary
//! The prepared-event write, shared by individual and batch response readers.
use super::{
    hooks::LifecycleTrailHooks, insert::insert_lifecycle_row, prepare::PreparedLifecycleEvent,
    record::apply_lifecycle_head,
};
use crate::{HrError, cases::open::event_with_register, own_record::own_record_guard};
use console_kernel_core::{
    AuditAction, AuditClassification, AuditEvent, ChangeMode, OrgId, TraceContext, UserId,
};
use console_platform_authz::Feature::EmployeeDirectoryManage;
use serde_json::json;
use sqlx::Postgres;
use time::OffsetDateTime;
use uuid::Uuid;

/// A bulk action shares its loaded register through the caller's hooks.
pub(super) async fn record_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    employee_id: Uuid,
    prepared: &PreparedLifecycleEvent,
    batch_id: Option<Uuid>,
    hooks: &LifecycleTrailHooks<'_>,
) -> Result<(Uuid, AuditEvent), HrError> {
    // Every write path meets the self-record rule here.
    own_record_guard(tx, org, actor, employee_id, EmployeeDirectoryManage).await?;
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
    if let Some(replaced) = superseded {
        crate::cases::open::cancel(tx, org_uuid, replaced, "SCHEDULE_REPLACED").await?;
    }
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
    // The 운영 시작 preview includes leave and transfer records entered during setup.
    .with_classification(AuditClassification {
        badges: (*change_mode == Some(ChangeMode::Setup)).then(|| vec!["setup".to_owned()]),
        anomaly: None,
        reason: None,
    });
    let scheduled_request = scheduled
        .then(|| serde_json::to_value(transition))
        .transpose()
        .map_err(|_| HrError::internal("scheduled request serialization failed"))?;

    insert_lifecycle_row(
        tx,
        (org_uuid, lifecycle_id, *actor.as_uuid(), batch_id),
        employee_id,
        prepared,
        scheduled_request,
    )
    .await?;

    if scheduled && !hooks.defer_cases {
        let register = hooks.register;
        event_with_register(tx, org_uuid, lifecycle_id, register).await?;
    } else if !scheduled {
        apply_lifecycle_head(
            tx,
            hooks,
            org_uuid,
            lifecycle_id,
            *actor.as_uuid(),
            employee_id,
            transition,
            target,
        )
        .await?;
    }

    Ok((lifecycle_id, event))
}
