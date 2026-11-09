// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "schedule/support.rs"]
mod support;

#[path = "excess_store/cancel_race.rs"]
mod cancel_race;
#[path = "excess_store/foreign_keys.rs"]
mod foreign_keys;
#[path = "excess_store/invariants.rs"]
mod invariants;
#[path = "excess_store/support.rs"]
mod store_support;

use sqlx::PgPool;
use store_support::{CANCEL, approval, code, item, runtime};
use support::world;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn approvals_keep_original_and_cancel_once_without_mutation(pool: PgPool) {
    let w = world(pool).await;
    let id = approval(&w).await;
    let cancel = CANCEL;
    let mut tx = runtime(&w).await;
    let cancellation: Uuid = sqlx::query_scalar(cancel)
        .bind(id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    for (target, expected) in [(id, "23505"), (cancellation, "23514")] {
        let mut tx = runtime(&w).await;
        assert_eq!(
            code(
                sqlx::query(cancel)
                    .bind(target)
                    .execute(&mut *tx)
                    .await
                    .unwrap_err()
            ),
            expected
        );
        tx.rollback().await.unwrap();
    }
    for statement in [
        "UPDATE attendance_overtime_approvals SET to_minutes = 1260 WHERE id = $1",
        "DELETE FROM attendance_overtime_approvals WHERE id = $1",
    ] {
        // The trigger protects records even from a writer with owner privileges.
        assert_eq!(
            code(
                sqlx::query(statement)
                    .bind(id)
                    .execute(&w.owner)
                    .await
                    .unwrap_err()
            ),
            "55000"
        );
    }
    let mut tx = runtime(&w).await;
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM attendance_overtime_approvals")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(rows, 2);
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn approval_window_method_evidence_and_cancellation_subject_are_checked(pool: PgPool) {
    let w = world(pool).await;
    let id = approval(&w).await;
    let mut tx = runtime(&w).await;
    sqlx::query("INSERT INTO attendance_overtime_approvals \
        (org_id, employee_id, work_date, from_minutes, to_minutes, approver_employee_id, method_code, evidence, recorded_by) \
        SELECT org_id, employee_id, work_date, 1560, 1680, approver_employee_id, method_code, evidence, recorded_by \
        FROM attendance_overtime_approvals WHERE id = $1")
        .bind(id).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    for change in [
        "0, 0, 'WRITTEN', '[]'::jsonb, NULL::uuid",
        "-1, 1200, 'WRITTEN', '[]'::jsonb, NULL::uuid",
        "1080, 2881, 'WRITTEN', '[]'::jsonb, NULL::uuid",
        "1080, 1200, NULL::text, '[]'::jsonb, NULL::uuid",
        "1080, 1200, 'UNKNOWN', '[]'::jsonb, NULL::uuid",
        "1080, 1200, 'WRITTEN', '{}'::jsonb, NULL::uuid",
    ] {
        let mut tx = runtime(&w).await;
        let statement = format!(
            "INSERT INTO attendance_overtime_approvals \
            (org_id, employee_id, work_date, approver_employee_id, recorded_by, from_minutes, to_minutes, method_code, evidence, cancels_id) \
            SELECT $1, $2, DATE '2026-10-06', $3, $4, {change}"
        );
        let error = sqlx::query(sqlx::AssertSqlSafe(statement))
            .bind(w.org)
            .bind(w.people[0])
            .bind(w.people[1])
            .bind(w.admin)
            .execute(&mut *tx)
            .await
            .unwrap_err();
        assert!(
            ["23514", "23502"].contains(&code(error).as_str()),
            "{change}"
        );
        tx.rollback().await.unwrap();
    }
    let mut tx = runtime(&w).await;
    let error = sqlx::query(
        "INSERT INTO attendance_overtime_approvals \
         (org_id, employee_id, work_date, from_minutes, to_minutes, approver_employee_id, method_code, evidence, recorded_by, cancels_id) \
         VALUES ($1, $2, DATE '2026-10-06', 1080, 1200, $3, 'WRITTEN', '[]', $4, $5)",
    ).bind(w.org).bind(w.people[2]).bind(w.people[1]).bind(w.admin).bind(id)
        .execute(&mut *tx).await.unwrap_err();
    assert_eq!(code(error), "23503");
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn approval_store_is_tenant_isolated_and_runtime_is_append_only(pool: PgPool) {
    let w = world(pool).await;
    approval(&w).await;
    let mut tx = runtime(&w).await;
    for privilege in ["UPDATE", "DELETE", "TRUNCATE"] {
        let allowed: bool = sqlx::query_scalar(
            "SELECT has_table_privilege(current_user, 'attendance_overtime_approvals', $1)",
        )
        .bind(privilege)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert!(!allowed, "runtime must not have {privilege}");
    }
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(Uuid::new_v4().to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM attendance_overtime_approvals")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(rows, 0);
    tx.rollback().await.unwrap();
    let mut tx = runtime(&w).await;
    sqlx::query("SELECT set_config('app.current_org', '', true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM attendance_overtime_approvals")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(rows, 0);
    let error = sqlx::query("INSERT INTO attendance_overtime_approvals \
        (org_id, employee_id, work_date, from_minutes, to_minutes, approver_employee_id, method_code, evidence, recorded_by) \
        VALUES ($1, $2, DATE '2026-10-06', 1080, 1200, $3, 'WRITTEN', '[]', $4)")
        .bind(w.org).bind(w.people[0]).bind(w.people[1]).bind(w.admin).execute(&mut *tx).await.unwrap_err();
    assert_eq!(code(error), "42501");
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn excess_windows_have_deadline_scope_and_a_unique_identity(pool: PgPool) {
    let w = world(pool).await;
    let id = item(&w, "UNAPPROVED_OVERTIME", 420, 540).await;
    item(&w, "UNAPPROVED_OVERTIME", 1080, 1200).await;
    item(&w, "HOLIDAY_WORK", 540, 1080).await;
    item(&w, "UNAPPROVED_OVERTIME", 1560, 1680).await;
    let complete: bool = sqlx::query_scalar("SELECT due_on = DATE '2026-10-09' AND workplace_id = $2 AND org_unit_id = $3 FROM attendance_exceptions WHERE id = $1")
        .bind(id).bind(w.workplaces[0]).bind(w.team).fetch_one(&w.owner).await.unwrap();
    assert!(complete);
    for window in [
        "NULL, 540, DATE '2026-10-09'",
        "420, NULL, DATE '2026-10-09'",
        "540, 420, DATE '2026-10-09'",
        "420, 540, NULL::date",
    ] {
        let mut tx = runtime(&w).await;
        let statement = format!(
            "INSERT INTO attendance_exceptions \
            (org_id, code, kind, employee_id, work_date, detail, created_by, idempotency_key, request_fingerprint, from_minutes, to_minutes, due_on) \
            SELECT org_id, 'invalid-excess-window', kind, employee_id, work_date, detail, created_by, \
            'invalid-excess-window', request_fingerprint, {window} FROM attendance_exceptions WHERE id = $1"
        );
        let error = sqlx::query(sqlx::AssertSqlSafe(statement))
            .bind(id)
            .execute(&mut *tx)
            .await
            .unwrap_err();
        assert_eq!(code(error), "23514", "{window}");
        tx.rollback().await.unwrap();
    }
    let mut tx = runtime(&w).await;
    sqlx::query("INSERT INTO attendance_exceptions \
        (org_id, code, kind, employee_id, work_date, detail, created_by, idempotency_key, request_fingerprint) \
        SELECT org_id, 'legacy-overtime-write', kind, employee_id, work_date, detail, created_by, \
        'legacy-overtime-write', request_fingerprint FROM attendance_exceptions WHERE id = $1")
        .bind(id).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let mut tx = runtime(&w).await;
    let duplicate = sqlx::query("INSERT INTO attendance_exceptions \
        (org_id, code, kind, employee_id, work_date, detail, created_by, idempotency_key, request_fingerprint, from_minutes, to_minutes, due_on, workplace_id, org_unit_id) \
        SELECT org_id, 'another-excess-window', kind, employee_id, work_date, detail, created_by, \
        'another-excess-window', request_fingerprint, from_minutes, to_minutes, due_on, workplace_id, org_unit_id FROM attendance_exceptions WHERE id = $1")
        .bind(id).execute(&mut *tx).await.unwrap_err();
    assert_eq!(code(duplicate), "23505");
    tx.rollback().await.unwrap();
    let error = sqlx::query(
        "UPDATE attendance_exceptions SET due_on = due_on + 1, status = 'RESOLVED' WHERE id = $1",
    )
    .bind(id)
    .execute(&w.owner)
    .await
    .unwrap_err();
    assert_eq!(
        code(error),
        "25006",
        "terminal transition cannot rewrite item evidence"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn new_dispositions_are_final_immutable_and_old_writes_remain_valid(pool: PgPool) {
    let w = world(pool).await;
    for (index, action) in [
        "CONFIRM",
        "APPROVE_OVERTIME",
        "POST_APPROVAL",
        "NOT_WORK",
        "RECORD_CORRECTION",
        "PAID_OVER_CAP",
    ]
    .into_iter()
    .enumerate()
    {
        let item_id = item(
            &w,
            "UNAPPROVED_OVERTIME",
            1080,
            1081 + i32::try_from(index).unwrap(),
        )
        .await;
        let mut tx = runtime(&w).await;
        let entry_id = foreign_keys::entry(&w).await;
        let changes = serde_json::json!({"action": action,
            "reason_code": if action == "RECORD_CORRECTION" { "TIME_INPUT_ERROR" } else { "PERSONAL_PRESENCE" },
            "superseding_entry_id": entry_id});
        let id = if ["CONFIRM", "APPROVE_OVERTIME"].contains(&action) {
            sqlx::query_scalar(
                "INSERT INTO attendance_exception_resolutions \
                (org_id, exception_id, action, reason, linked_work_ref, actor_user_id) \
                VALUES ($1, $2, $3, '검토 기록', '기록부', $4) RETURNING id",
            )
            .bind(w.org)
            .bind(item_id)
            .bind(action)
            .bind(w.admin)
            .fetch_one(&mut *tx)
            .await
            .unwrap()
        } else {
            invariants::resolution(&mut tx, &w, item_id, changes)
                .await
                .unwrap()
        };
        sqlx::query("UPDATE attendance_exceptions SET status = 'RESOLVED' WHERE id = $1")
            .bind(item_id)
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        for statement in [
            "UPDATE attendance_exception_resolutions SET reason = 'rewrite' WHERE id = $1",
            "DELETE FROM attendance_exception_resolutions WHERE id = $1",
        ] {
            let error = sqlx::query(statement)
                .bind(id)
                .execute(&w.owner)
                .await
                .unwrap_err();
            assert_eq!(
                code(error),
                if ["CONFIRM", "APPROVE_OVERTIME"].contains(&action) {
                    "25006"
                } else {
                    "55000"
                }
            );
        }
        let mut tx = runtime(&w).await;
        let error = sqlx::query("INSERT INTO attendance_exception_resolutions \
            (org_id, exception_id, action, reason, actor_user_id) VALUES ($1, $2, 'CONFIRM', 'second decision', $3)")
            .bind(w.org).bind(item_id).bind(w.admin).execute(&mut *tx).await.unwrap_err();
        assert_eq!(code(error), "23505");
        tx.rollback().await.unwrap();
    }
}
