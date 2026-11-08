// SPDX-License-Identifier: LicenseRef-Proprietary
//! Weekly totals use persisted entries, dated schedules and resolved approvals.
use super::save::{cell, paper, save, scheduled};
use super::support::{key, seed};
use serde_json::json;
use sqlx::PgPool;
use time::macros::date;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn weekly_totals_exclude_open_overtime_and_preserve_unknown(owner: PgPool) {
    let w = scheduled(owner).await;
    w.store
        .save_entries(
            &w.hr(),
            &key(),
            save(vec![
                cell(&w, 0, date!(2026 - 10 - 06), "9-20"),
                cell(&w, 1, date!(2026 - 10 - 06), "결"),
                cell(&w, 2, date!(2026 - 10 - 06), "9-20"),
            ]),
        )
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET hire_on='2026-10-06' WHERE id=$1")
        .bind(w.people[0])
        .execute(&w.owner)
        .await
        .unwrap();
    let workplace = w.workplaces[0];
    let scoped = w
        .store
        .week52_inputs(&w.hr(), date!(2026 - 10 - 05), None, move |_| {
            Box::pin(async move {
                Ok(Box::new(move |target| {
                    Ok(match target {
                        console_attendance_adapter_postgres::BoardReadTarget::Person {
                            workplace: Some(id),
                        } => id == workplace,
                        _ => false,
                    })
                })
                    as console_attendance_adapter_postgres::BoardReadAccess)
            })
        })
        .await
        .unwrap();
    assert!(
        scoped.iter().any(|r| r.employee_id == w.people[0]),
        "a midweek hire stays in its workplace read set"
    );
    let read = || async {
        w.store
            .week52_inputs(&w.hr(), date!(2026 - 10 - 05), None, |_| {
                Box::pin(async {
                    Ok(Box::new(|_| Ok(true))
                        as console_attendance_adapter_postgres::BoardReadAccess)
                })
            })
            .await
            .unwrap()
    };
    let rows = read().await;
    let row =
        |id| serde_json::to_value(rows.iter().find(|r| r.employee_id == id).unwrap()).unwrap();
    assert_eq!(row(w.people[0])["recognized_hours"], json!(8.0));
    assert_eq!(row(w.people[0])["overtime_hours"], json!(0.0));
    assert_eq!(row(w.people[1])["recognized_hours"], json!(0.0));
    assert_eq!(row(w.people[1])["overtime_hours"], json!(0.0));
    assert!(row(w.people[2])["recognized_hours"].is_null());
    assert!(row(w.people[2])["overtime_hours"].is_null());
    let (org, employee, actor) = (w.org, w.people[0], w.admin);
    seed(&w.owner, format!("INSERT INTO attendance_exceptions (org_id,id,code,kind,status,employee_id,work_date,detail,idempotency_key,request_fingerprint,created_by)
      VALUES ('{org}','00000000-0000-4000-8000-000000000901','AT-WEEK','UNAPPROVED_OVERTIME','RESOLVED','{employee}','2026-10-06','verified work','weekly-approved-work',repeat('a',64),'{actor}');
      INSERT INTO attendance_exception_resolutions (org_id,exception_id,action,reason,linked_work_ref,ot_hours,actor_user_id)
      VALUES ('{org}','00000000-0000-4000-8000-000000000901','APPROVE_OVERTIME','verified','work',1.25,'{actor}');")).await;
    let rows = read().await;
    let row =
        serde_json::to_value(rows.iter().find(|r| r.employee_id == employee).unwrap()).unwrap();
    assert_eq!(row["recognized_hours"], json!(9.25));
    assert_eq!(row["overtime_hours"], json!(1.25));
    // An approval cannot create worked time.
    seed(
        &w.owner,
        "UPDATE attendance_exception_resolutions SET ot_hours=9".into(),
    )
    .await;
    let rows = read().await;
    let row =
        serde_json::to_value(rows.iter().find(|r| r.employee_id == employee).unwrap()).unwrap();
    assert_eq!(row["recognized_hours"], json!(10.0));
    assert_eq!(row["overtime_hours"], json!(2.0));
    seed(
        &w.owner,
        "UPDATE attendance_exception_resolutions SET ot_hours=NULL".into(),
    )
    .await;
    let rows = read().await;
    let row =
        serde_json::to_value(rows.iter().find(|r| r.employee_id == employee).unwrap()).unwrap();
    assert_eq!(row.get("recognized_hours"), Some(&serde_json::Value::Null));
    assert_eq!(row.get("overtime_hours"), Some(&serde_json::Value::Null));
    let rows = w
        .store
        .week52_inputs(&w.hr(), date!(2026 - 10 - 12), None, |_| {
            Box::pin(async {
                Ok(Box::new(|_| Ok(true)) as console_attendance_adapter_postgres::BoardReadAccess)
            })
        })
        .await
        .unwrap();
    for row in rows {
        let row = serde_json::to_value(row).unwrap();
        assert!(row.get("recognized_hours").unwrap().is_null());
        assert!(row.get("overtime_hours").unwrap().is_null());
    }
    w.store
        .save_entries(
            &w.hr(),
            &key(),
            save(vec![cell(&w, 1, date!(2026 - 10 - 07), "9-")]),
        )
        .await
        .unwrap();
    let rows = read().await;
    let partial =
        serde_json::to_value(rows.iter().find(|r| r.employee_id == w.people[1]).unwrap()).unwrap();
    assert_eq!(
        partial.get("recognized_hours"),
        Some(&serde_json::Value::Null)
    );
    seed(
        &w.owner,
        "UPDATE attendance_exception_resolutions SET ot_hours=1.25".into(),
    )
    .await;
    let entry = sqlx::query_scalar("SELECT id FROM attendance_entries WHERE employee_id=$1")
        .bind(employee)
        .fetch_one(&w.owner)
        .await
        .unwrap();
    w.store
        .void_entry(
            &w.hr(),
            &key(),
            entry,
            console_attendance_application::records::VoidInput {
                reason: "다른 사람 기록".into(),
                evidence: paper(),
            },
        )
        .await
        .unwrap();
    let rows = read().await;
    let voided =
        serde_json::to_value(rows.iter().find(|r| r.employee_id == employee).unwrap()).unwrap();
    assert_eq!(
        voided.get("recognized_hours"),
        Some(&serde_json::Value::Null)
    );
}
