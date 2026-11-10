// SPDX-License-Identifier: LicenseRef-Proprietary
use super::support::World;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub(super) const CANCEL: &str = "INSERT INTO attendance_overtime_approvals \
    (org_id, employee_id, work_date, from_minutes, to_minutes, approver_employee_id, method_code, evidence, recorded_by, cancels_id) \
    SELECT org_id, employee_id, work_date, from_minutes, to_minutes, approver_employee_id, method_code, evidence, recorded_by, id \
    FROM attendance_overtime_approvals WHERE id = $1 RETURNING id";

pub(super) async fn runtime(w: &World) -> Transaction<'static, Postgres> {
    let mut tx = w.owner.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_rt")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(w.org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    tx
}

pub(super) fn code(error: sqlx::Error) -> String {
    error
        .as_database_error()
        .unwrap()
        .code()
        .unwrap()
        .into_owned()
}

pub(super) async fn approval(w: &World) -> Uuid {
    let mut tx = runtime(w).await;
    let id = sqlx::query_scalar(
        "INSERT INTO attendance_overtime_approvals \
         (org_id, employee_id, work_date, from_minutes, to_minutes, approver_employee_id, method_code, evidence, recorded_by) \
         VALUES ($1, $2, DATE '2026-10-06', 1080, 1200, $3, 'WRITTEN', \
         '[{\"kind\":\"PAPER_SHEET\",\"note\":\"승인 기록\"}]', $4) RETURNING id",
    ).bind(w.org).bind(w.people[0]).bind(w.people[1]).bind(w.admin)
        .fetch_one(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    id
}

pub(super) async fn item(w: &World, kind: &str, start: i32, end: i32) -> Uuid {
    let id = Uuid::new_v4();
    let mut tx = runtime(w).await;
    sqlx::query(
        "INSERT INTO attendance_exceptions \
         (id, org_id, code, kind, employee_id, work_date, detail, created_by, idempotency_key, request_fingerprint, \
         from_minutes, to_minutes, due_on, workplace_id, org_unit_id) \
         VALUES ($1, $2, $3, $4, $5, DATE '2026-10-06', '소정 밖 근로', $6, $3, repeat('a', 64), \
         $7, $8, DATE '2026-10-09', $9, $10)",
    ).bind(id).bind(w.org).bind(id.to_string()).bind(kind).bind(w.people[0]).bind(w.admin)
        .bind(start).bind(end).bind(w.workplaces[0]).bind(w.team)
        .execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    id
}
