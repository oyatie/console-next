// SPDX-License-Identifier: LicenseRef-Proprietary
use super::invariants::resolution;
use super::store_support::{code, item, runtime};
use super::support::world;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn approval_dispositions_accept_only_their_reason_domain(pool: PgPool) {
    let w = world(pool).await;
    let id = item(&w, "UNAPPROVED_OVERTIME", 1080, 1200).await;
    for (action, domain, valid, other) in [
        (
            "POST_APPROVAL",
            "excess_post_approval",
            "WORK_CONFIRMED",
            "STATUTORY_CAP_EXCEEDED",
        ),
        (
            "PAID_OVER_CAP",
            "excess_paid_over_cap",
            "STATUTORY_CAP_EXCEEDED",
            "WORK_CONFIRMED",
        ),
    ] {
        for reason in [
            None,
            Some(""),
            Some("GARBAGE"),
            Some("PERSONAL_PRESENCE"),
            Some("TIME_INPUT_ERROR"),
            Some(other),
        ] {
            let mut tx = runtime(&w).await;
            let error = resolution(
                &mut tx,
                &w,
                id,
                json!({"action": action, "reason_code": reason}),
            )
            .await
            .unwrap_err();
            assert_eq!(code(error), "23514", "{action}: {reason:?}");
            tx.rollback().await.unwrap();
        }
        let mut tx = runtime(&w).await;
        resolution(
            &mut tx,
            &w,
            id,
            json!({"action": action, "reason_code": valid}),
        )
        .await
        .unwrap();
        tx.rollback().await.unwrap();
        for (reason_domain, active) in [
            (domain, true),
            (domain, false),
            ("attendance_correction", true),
        ] {
            let reason = format!("T_{}", Uuid::new_v4().simple()).to_uppercase();
            let mut tx = runtime(&w).await;
            sqlx::query("INSERT INTO reason_codes (org_id, domain, code, label_ko, requires_note, active, created_by) \
                VALUES ($1, $2, $3, $3, false, $4, $5)")
                .bind(w.org).bind(reason_domain).bind(&reason).bind(active).bind(w.admin)
                .execute(&mut *tx).await.unwrap();
            let result = resolution(
                &mut tx,
                &w,
                id,
                json!({"action": action, "reason_code": reason}),
            )
            .await;
            if reason_domain == domain && active {
                result.unwrap();
            } else {
                assert_eq!(code(result.unwrap_err()), "23514");
            }
            tx.rollback().await.unwrap();
        }
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM attendance_exception_resolutions")
        .fetch_one(&w.owner)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn excess_dispositions_require_an_excess_window_and_keep_legacy_confirm(pool: PgPool) {
    let w = world(pool).await;
    let source = item(&w, "UNAPPROVED_OVERTIME", 1080, 1200).await;
    let entry = super::foreign_keys::entry(&w).await;
    for (kind, window) in [
        ("LATE", false),
        ("LATE", true),
        ("NO_SHOW", false),
        ("EARLY_LEAVE", false),
        ("UNAPPROVED_OVERTIME", false),
    ] {
        let mut tx = runtime(&w).await;
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO attendance_exceptions \
             (org_id, code, kind, employee_id, work_date, detail, created_by, idempotency_key, request_fingerprint, \
              from_minutes, to_minutes, due_on) \
             SELECT org_id, $2, $3, employee_id, work_date, detail, created_by, $2, request_fingerprint, \
              CASE WHEN $4 THEN from_minutes END, CASE WHEN $4 THEN to_minutes END, due_on \
             FROM attendance_exceptions WHERE id = $1 RETURNING id",
        ).bind(source).bind(Uuid::new_v4().to_string()).bind(kind).bind(window)
            .fetch_one(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
        for action in [
            "POST_APPROVAL",
            "NOT_WORK",
            "RECORD_CORRECTION",
            "PAID_OVER_CAP",
        ] {
            let reason = match action {
                "NOT_WORK" => Some("PERSONAL_PRESENCE"),
                "RECORD_CORRECTION" => Some("TIME_INPUT_ERROR"),
                "POST_APPROVAL" => Some("WORK_CONFIRMED"),
                "PAID_OVER_CAP" => Some("STATUTORY_CAP_EXCEEDED"),
                _ => None,
            };
            let mut tx = runtime(&w).await;
            let error = resolution(
                &mut tx,
                &w,
                id,
                json!({"action": action,
                "reason_code": reason, "superseding_entry_id": entry}),
            )
            .await
            .unwrap_err();
            assert_eq!(code(error), "23514", "{action}: {kind}");
            tx.rollback().await.unwrap();
        }
        let mut tx = runtime(&w).await;
        resolution(&mut tx, &w, id, json!({"action": "CONFIRM"}))
            .await
            .unwrap();
        tx.rollback().await.unwrap();
    }
    let id = item(&w, "HOLIDAY_WORK", 540, 1080).await;
    for action in [
        "POST_APPROVAL",
        "NOT_WORK",
        "RECORD_CORRECTION",
        "PAID_OVER_CAP",
    ] {
        let reason = match action {
            "NOT_WORK" => Some("PERSONAL_PRESENCE"),
            "RECORD_CORRECTION" => Some("TIME_INPUT_ERROR"),
            "POST_APPROVAL" => Some("WORK_CONFIRMED"),
            "PAID_OVER_CAP" => Some("STATUTORY_CAP_EXCEEDED"),
            _ => None,
        };
        let mut tx = runtime(&w).await;
        resolution(
            &mut tx,
            &w,
            id,
            json!({"action": action,
            "reason_code": reason, "superseding_entry_id": entry}),
        )
        .await
        .unwrap();
        tx.rollback().await.unwrap();
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM attendance_exception_resolutions")
        .fetch_one(&w.owner)
        .await
        .unwrap();
    assert_eq!(count, 0);
}
