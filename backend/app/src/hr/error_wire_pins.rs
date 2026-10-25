//! R2 step 0(a): pins the wire (status, `error.code`, `error.message`,
//! `error.refusals`) of every `HrError` constructor and `From` impl, so moving
//! `HrError` out of `hr.rs` cannot change a response byte. `from_kernel` is
//! pinned with uncoded `KernelError`s only: honouring `KernelError.code` is a
//! later, deliberate change.
#![allow(clippy::unwrap_used)]

use super::{HrError, employment};
use axum::body::to_bytes;
use axum::response::IntoResponse;
use console_kernel_core::KernelError;
use console_leave_adapter_postgres::PgLeaveError;
use console_leave_domain::LeaveChargeReviewReason;
use console_ontology_canonical_adapter_postgres::person::PersonError;
use console_platform_db::DbError;
use serde_json::{Value, json};
use uuid::Uuid;

const ID: &str = "00000000-0000-0000-0000-00000000000a";
const DB_FAILED: &str = "employee directory request failed";

async fn wire(error: HrError) -> (u16, Value) {
    let response = console_hr_rest::HrApiError(error).into_response();
    let status = response.status().as_u16();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

async fn pin(error: HrError, status: u16, code: &str, message: &str) {
    let expected = json!({ "error": { "code": code, "message": message } });
    assert_eq!(wire(error).await, (status, expected), "{code}: {message}");
}

fn id() -> Uuid {
    ID.parse().unwrap()
}

#[tokio::test]
async fn hr_error_wire_pins_kernel_kinds() {
    let kinds = [
        (KernelError::validation("v"), 422, "validation"),
        (KernelError::not_found("n"), 404, "not_found"),
        (KernelError::forbidden("f"), 403, "forbidden"),
        (KernelError::conflict("c"), 409, "conflict"),
        (
            KernelError::invalid_transition("t"),
            409,
            "invalid_transition",
        ),
        (KernelError::internal("i"), 500, "internal"),
    ];
    for (error, status, code) in kinds {
        let message = error.message.clone();
        pin(HrError::from_kernel(error.clone()), status, code, &message).await;
        pin(HrError::from(error), status, code, &message).await;
    }
    pin(HrError::validation("bad"), 422, "validation", "bad").await;
}

#[tokio::test]
async fn hr_error_wire_pins_custom_constructors() {
    pin(
        HrError::signoff_required("payroll_cutoff_ack", "TERMINATE"),
        422,
        "lifecycle_signoff_required",
        "payroll_cutoff_ack is required for TERMINATE",
    )
    .await;
    pin(
        HrError::scheduled_state("EXITED", "2026-11-10", "TERMINATE"),
        409,
        "lifecycle_scheduled_state",
        "the employee will be EXITED from 2026-11-10 by the scheduled TERMINATE",
    )
    .await;
    pin(
        HrError::lifecycle_noop("TRANSFER"),
        422,
        "lifecycle_noop",
        "TRANSFER would not change the employee",
    )
    .await;
    pin(HrError::workbook("sheet"), 422, "workbook", "sheet").await;
    pin(HrError::internal("boom"), 500, "internal", "boom").await;
    pin(
        HrError::unavailable("down"),
        503,
        "service_unavailable",
        "down",
    )
    .await;
}

#[tokio::test]
async fn hr_error_wire_pins_refusals() {
    let refusal = json!({ "employee_id": "e1", "code": "lifecycle_noop", "message": "m" });
    assert_eq!(
        wire(HrError::bulk_refused(vec![refusal.clone()], 3)).await,
        (
            422,
            json!({ "error": {
                "code": "bulk_lifecycle_refused",
                "message": "1 of 3 employees cannot take this change; nothing was recorded",
                "refusals": [refusal.clone()],
            }})
        )
    );
    assert_eq!(
        wire(HrError::schedule_conflict(vec![
            refusal.clone(),
            refusal.clone()
        ]))
        .await,
        (
            409,
            json!({ "error": {
                "code": "lifecycle_schedule_conflict",
                "message": "2 scheduled lifecycle events would no longer apply after this change; cancel or change them first",
                "refusals": [refusal.clone(), refusal],
            }})
        )
    );
}

#[tokio::test]
async fn hr_error_wire_pins_leave_store() {
    let leave = |error| HrError::from_leave_store(error);
    pin(
        leave(PgLeaveError::CommandUnavailable),
        503,
        "service_unavailable",
        "leave command database is not configured; protected employee leave changes are unavailable",
    )
    .await;
    pin(
        leave(PgLeaveError::Domain(KernelError::forbidden("no"))),
        403,
        "forbidden",
        "no",
    )
    .await;
    pin(
        leave(PgLeaveError::ConcurrentModification),
        409,
        "conflict",
        "employee changed since it was read; reload before retrying the protected leave change",
    )
    .await;
    pin(
        leave(PgLeaveError::Db(DbError::CodeIssuance("x".into()))),
        500,
        "internal",
        DB_FAILED,
    )
    .await;
    let failed = "protected employee leave change failed";
    pin(
        leave(PgLeaveError::MissingHomeBranch),
        500,
        "internal",
        failed,
    )
    .await;
    pin(
        leave(PgLeaveError::ChargeReviewRequired(vec![
            LeaveChargeReviewReason::MissingCalendar,
        ])),
        500,
        "internal",
        failed,
    )
    .await;
}

#[tokio::test]
async fn hr_error_wire_pins_from_impls() {
    pin(
        HrError::from(DbError::CodeIssuance("x".into())),
        500,
        "internal",
        DB_FAILED,
    )
    .await;
    pin(
        HrError::from(sqlx::Error::RowNotFound),
        500,
        "internal",
        DB_FAILED,
    )
    .await;

    let applied = format!("command {ID} was already applied with a different payload");
    pin(
        HrError::from(PersonError::Blocked(vec!["dup".into()])),
        422,
        "validation",
        "preflight blocked the command: [\"dup\"]",
    )
    .await;
    pin(
        HrError::from(PersonError::DigestConflict(id())),
        409,
        "conflict",
        &applied,
    )
    .await;
    pin(
        HrError::from(PersonError::Database(sqlx::Error::RowNotFound)),
        500,
        "internal",
        DB_FAILED,
    )
    .await;
    pin(
        HrError::from(PersonError::UnreadableReceipt(id(), "r".into())),
        500,
        "internal",
        DB_FAILED,
    )
    .await;

    use employment::EmploymentError as E;
    pin(
        HrError::from(E::Frozen(KernelError::conflict("closed"))),
        409,
        "conflict",
        "closed",
    )
    .await;
    pin(
        HrError::from(E::Frozen(KernelError::internal("gate sql"))),
        500,
        "internal",
        "employment change could not be applied",
    )
    .await;
    pin(
        HrError::from(E::Database(sqlx::Error::RowNotFound)),
        500,
        "internal",
        DB_FAILED,
    )
    .await;
    pin(
        HrError::from(E::UnknownOrgUnit(id())),
        422,
        "validation",
        &format!("org_unit_id {ID} is not a known OrgUnit in this tenant"),
    )
    .await;
    pin(
        HrError::from(E::UnknownJobPosition(id())),
        422,
        "validation",
        &format!("job_position_id {ID} is not a known JobPosition in this tenant"),
    )
    .await;
    pin(
        HrError::from(E::OrgUnitRefNotUuid),
        422,
        "validation",
        "fromOrgUnit/toOrgUnit must be OrgUnit UUIDs, not free-text team labels",
    )
    .await;
    // Any other variant: internal with the variant's own text.
    pin(
        HrError::from(E::DigestConflict(id())),
        500,
        "internal",
        &applied,
    )
    .await;
}

#[path = "legal_wire_pins.rs"]
mod legal_wire_pins;
