// SPDX-License-Identifier: LicenseRef-Proprietary
use super::store_support::{approval, code, item, runtime};
use super::support::{World, world};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub(super) async fn resolution(
    tx: &mut Transaction<'_, Postgres>,
    w: &World,
    item_id: Uuid,
    changes: Value,
) -> Result<Uuid, sqlx::Error> {
    let mut fields = json!({"action": "NOT_WORK", "reason_code": "PERSONAL_PRESENCE",
        "evidence": [{"kind": "PAPER_SHEET", "note": "확인 기록"}], "worker_notice_via": "IN_APP"});
    fields
        .as_object_mut()
        .unwrap()
        .extend(changes.as_object().unwrap().clone());
    sqlx::query_scalar(
        "INSERT INTO attendance_exception_resolutions \
         (org_id, exception_id, action, reason, actor_user_id, reason_code, evidence, \
          worker_notice_via, worker_notified_on, superseding_entry_id) \
         VALUES ($1, $2, $4->>'action', '검토 기록', $3, $4->>'reason_code', \
          NULLIF($4->'evidence', 'null'::jsonb), $4->>'worker_notice_via', \
          ($4->>'worker_notified_on')::date, ($4->>'superseding_entry_id')::uuid) RETURNING id",
    )
    .bind(w.org)
    .bind(item_id)
    .bind(w.admin)
    .bind(fields)
    .fetch_one(&mut **tx)
    .await
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn incomplete_dispositions_cannot_become_permanent(pool: sqlx::PgPool) {
    let w = world(pool).await;
    let id = item(&w, "UNAPPROVED_OVERTIME", 1080, 1200).await;
    for invalid in [
        json!({"reason_code": null}),
        json!({"reason_code": ""}),
        json!({"reason_code": "UNKNOWN"}),
        json!({"reason_code": "TIME_INPUT_ERROR"}),
        json!({"evidence": null}),
        json!({"evidence": []}),
        json!({"evidence": {}}),
        json!({"worker_notice_via": null}),
        json!({"worker_notice_via": "VERBAL"}),
        json!({"worker_notice_via": "WRITTEN"}),
        json!({"worker_notice_via": "WRITTEN", "worker_notified_on": "2020-01-01"}),
        json!({"action": "RECORD_CORRECTION", "reason_code": "TIME_INPUT_ERROR"}),
        json!({"action": "POST_APPROVAL", "evidence": null}),
        json!({"action": "PAID_OVER_CAP", "evidence": null}),
    ] {
        let mut tx = runtime(&w).await;
        let error = resolution(&mut tx, &w, id, invalid.clone())
            .await
            .unwrap_err();
        assert_eq!(code(error), "23514", "{invalid}");
        tx.rollback().await.unwrap();
    }
    for valid in [
        json!({}),
        json!({"worker_notice_via": "WRITTEN", "worker_notified_on": "2026-10-06"}),
    ] {
        let mut tx = runtime(&w).await;
        resolution(&mut tx, &w, id, valid).await.unwrap();
        tx.rollback().await.unwrap();
    }
    for active in [true, false] {
        let reason = format!("T_{}", Uuid::new_v4().simple()).to_uppercase();
        let mut tx = runtime(&w).await;
        sqlx::query("INSERT INTO reason_codes (org_id, domain, code, label_ko, requires_note, active, created_by) \
            VALUES ($1, 'excess_not_work', $2, $2, false, $3, $4)")
            .bind(w.org).bind(&reason).bind(active).bind(w.admin)
            .execute(&mut *tx).await.unwrap();
        let result = resolution(&mut tx, &w, id, json!({"reason_code": reason})).await;
        if active {
            result.unwrap();
        } else {
            assert_eq!(code(result.unwrap_err()), "23514");
        }
        tx.rollback().await.unwrap();
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM attendance_exception_resolutions")
        .fetch_one(&w.owner)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn new_excess_requires_scope_window_and_chronological_deadline(pool: sqlx::PgPool) {
    let w = world(pool).await;
    for (kind, start, end, due, workplace, unit) in [
        (
            "HOLIDAY_WORK",
            None,
            None,
            None,
            Some(w.workplaces[0]),
            None,
        ),
        (
            "UNAPPROVED_OVERTIME",
            Some(1080),
            Some(1200),
            Some("2026-10-09"),
            None,
            None,
        ),
        (
            "HOLIDAY_WORK",
            Some(1080),
            Some(1200),
            Some("2026-10-09"),
            None,
            None,
        ),
        (
            "UNAPPROVED_OVERTIME",
            Some(1080),
            Some(1200),
            Some("2026-10-05"),
            Some(w.workplaces[0]),
            Some(w.team),
        ),
    ] {
        let mut tx = runtime(&w).await;
        let error = sqlx::query(
            "INSERT INTO attendance_exceptions \
            (org_id, code, kind, employee_id, work_date, detail, created_by, idempotency_key, \
             request_fingerprint, from_minutes, to_minutes, due_on, workplace_id, org_unit_id) \
            VALUES ($1, 'invalid-excess', $2, $3, DATE '2026-10-06', '초과 기록', $4, \
             'invalid-excess-item', repeat('a', 64), $5, $6, $7::text::date, $8, $9)",
        )
        .bind(w.org)
        .bind(kind)
        .bind(w.people[0])
        .bind(w.admin)
        .bind(start)
        .bind(end)
        .bind(due)
        .bind(workplace)
        .bind(unit)
        .execute(&mut *tx)
        .await
        .unwrap_err();
        assert_eq!(code(error), "23514", "{kind} {due:?}");
        tx.rollback().await.unwrap();
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn approval_cannot_cancel_itself(pool: sqlx::PgPool) {
    let w = world(pool).await;
    let id = Uuid::new_v4();
    let mut tx = runtime(&w).await;
    let error = sqlx::query(
        "INSERT INTO attendance_overtime_approvals \
        (id, org_id, employee_id, work_date, from_minutes, to_minutes, approver_employee_id, \
         method_code, evidence, recorded_by, cancels_id) \
        VALUES ($1, $2, $3, DATE '2026-10-06', 1080, 1200, $4, 'WRITTEN', '[]', $5, $1)",
    )
    .bind(id)
    .bind(w.org)
    .bind(w.people[0])
    .bind(w.people[1])
    .bind(w.admin)
    .execute(&mut *tx)
    .await
    .unwrap_err();
    assert_eq!(code(error), "23514");
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn approval_owner_without_tenant_context_sees_no_rows(pool: sqlx::PgPool) {
    let w = world(pool).await;
    approval(&w).await;
    let mut tx = w.owner.begin().await.unwrap();
    // The runtime role temporarily owns this table; FORCE must apply even to its owner.
    sqlx::query("ALTER TABLE attendance_overtime_approvals OWNER TO console_rt")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("SET LOCAL ROLE console_rt")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org', '', true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    let hidden: i64 = sqlx::query_scalar("SELECT count(*) FROM attendance_overtime_approvals")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(hidden, 0);
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(w.org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM attendance_overtime_approvals")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(visible, 1);
    tx.rollback().await.unwrap();
}
