// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Read-time action decisions use live Cedar facts, including outside the page.
#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;
#[path = "support/lifecycle_grant.rs"]
mod lifecycle_grant;

use console_hr_adapter_postgres::lifecycle::events_page::LifecycleEventsQuery;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

async fn seed(
    f: &fixture::Fixture,
    owner: &PgPool,
    employee: Uuid,
    kind: &str,
    state: &str,
    voids: Option<Uuid>,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO employee_lifecycle_events (id,org_id,employee_id,event_type,to_status,state,effective_date,comment,signoffs,created_by,created_at,voids_event_id,cancelled_at,failure_code) VALUES ($1,$2,$3,$4,'ACTIVE',$5,'2026-10-20','검증','{}',$6,clock_timestamp(),$7,CASE WHEN $5='CANCELLED' THEN now() END,CASE WHEN $5='APPLY_FAILED' THEN 'invalid_transition' END)")
        .bind(id).bind(f.principal.org_id.as_uuid()).bind(employee).bind(kind).bind(state)
        .bind(f.principal.user_id.as_uuid()).bind(voids).execute(owner).await.unwrap();
    id
}

async fn page(f: &fixture::Fixture, employee: Uuid, query: LifecycleEventsQuery) -> Value {
    serde_json::to_value(
        f.hr.lifecycle_events(f.principal.clone(), employee, query, true)
            .await
            .unwrap(),
    )
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn group_transfer_correction_uses_the_cedar_refusal_but_rescission_is_allowed(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(f.principal.user_id.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let employee = f
        .create(f.body("group-correction", "REGULAR"))
        .await
        .unwrap()
        .employee_id();
    let event = seed(&f, &pool, employee, "GROUP_TRANSFER", "APPLIED", None).await;
    let before = page(&f, employee, LifecycleEventsQuery::default()).await;
    assert_eq!(
        before["items"][0]["action_refusals"],
        json!({"correct": "lifecycle_void_unsupported"})
    );
    let error =
        f.hr.correct_lifecycle_event(
            f.principal.clone(),
            employee,
            event,
            serde_json::from_value(json!({
                "replacement": {
                    "event_type": "GROUP_TRANSFER", "effective_date": "2026-10-20",
                    "to_workplace_id": Uuid::new_v4(), "comment": "전적 정정 검증"
                },
                "reason_code": "INPUT_ERROR", "note": "회귀 검증"
            }))
            .unwrap(),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(error.status.as_u16(), 409);
    assert_eq!(error.code, before["items"][0]["action_refusals"]["correct"]);
    assert_eq!(error.message, "this event cannot be corrected or rescinded");
    let preview =
        f.hr.rescind_lifecycle_event(
            f.principal.clone(),
            employee,
            event,
            serde_json::from_value(json!({
                "reason_code": "INPUT_ERROR", "note": "회귀 검증"
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    assert!(preview.rescinded.is_none());
    assert_eq!(
        page(&f, employee, LifecycleEventsQuery::default()).await,
        before
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_event_refusal_is_server_authored_and_latest_is_not_page_local(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(f.principal.user_id.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let employee = f
        .create(f.body("refusals", "REGULAR"))
        .await
        .unwrap()
        .employee_id();
    let old = seed(&f, &pool, employee, "TRANSFER", "APPLIED", None).await;
    let voided = seed(&f, &pool, employee, "TRANSFER", "APPLIED", None).await;
    let rescind = seed(&f, &pool, employee, "RESCIND", "APPLIED", Some(voided)).await;
    let mut expected = vec![
        (old, "lifecycle_void_not_latest"),
        (voided, "lifecycle_event_voided"),
        (rescind, "lifecycle_void_unsupported"),
    ];
    for (kind, state, code) in [
        ("TRANSFER", "SCHEDULED", "lifecycle_void_not_applied"),
        ("TRANSFER", "CANCELLED", "lifecycle_void_not_applied"),
        ("TRANSFER", "APPLY_FAILED", "lifecycle_void_not_applied"),
        ("TERMINATE", "APPLIED", "lifecycle_void_exit_owned"),
        ("OFFBOARD", "APPLIED", "lifecycle_void_exit_owned"),
        ("EXIT_REVERSAL", "APPLIED", "lifecycle_void_exit_owned"),
        ("ONBOARD", "APPLIED", "lifecycle_void_unsupported"),
        ("REHIRE", "APPLIED", "lifecycle_void_unsupported"),
    ] {
        expected.push((seed(&f, &pool, employee, kind, state, None).await, code));
    }
    let group = seed(&f, &pool, employee, "GROUP_TRANSFER", "APPLIED", None).await;
    let first = page(
        &f,
        employee,
        LifecycleEventsQuery {
            limit: Some(1),
            cursor: None,
        },
    )
    .await;
    assert_eq!(first["items"][0]["id"], group.to_string());
    assert_eq!(
        first["items"][0]["action_refusals"],
        json!({"correct":"lifecycle_void_unsupported"})
    );
    let older = page(
        &f,
        employee,
        LifecycleEventsQuery {
            limit: Some(500),
            cursor: Some(first["next_cursor"].as_str().unwrap().to_owned()),
        },
    )
    .await;
    for (id, code) in expected {
        let item = older["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == id.to_string())
            .unwrap();
        assert_eq!(
            item["action_refusals"],
            json!({"correct":code,"rescind":code}),
            "{item}"
        );
    }
    let latest = seed(&f, &pool, employee, "TRANSFER", "APPLIED", None).await;
    let next = page(&f, employee, LifecycleEventsQuery::default()).await;
    assert_eq!(next["items"][0]["id"], latest.to_string());
    assert_eq!(next["items"][0]["action_refusals"], json!({}));
    // A handover commits atomically, preserving the tenant's one active ops account.
    let mut handover = pool.begin().await.unwrap();
    sqlx::query("UPDATE users SET is_tenant_ops=false WHERE id=$1")
        .bind(f.principal.user_id.as_uuid())
        .execute(handover.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO users(id,org_id,display_name,roles,is_tenant_ops) VALUES ($1,$2,'other ops',ARRAY['SUPER_ADMIN'],true)")
        .bind(Uuid::new_v4()).bind(f.principal.org_id.as_uuid()).execute(handover.as_mut()).await.unwrap();
    handover.commit().await.unwrap();
    let denied = page(&f, employee, LifecycleEventsQuery::default()).await;
    assert_eq!(
        denied["items"][0]["action_refusals"],
        json!({"correct":"forbidden","rescind":"forbidden"})
    );
    let error =
        f.hr.rescind_lifecycle_event(
            f.principal.clone(),
            employee,
            latest,
            serde_json::from_value(json!({"reason_code":"INPUT_ERROR"})).unwrap(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.status.as_u16(), 403);
    assert_eq!(error.code, "forbidden");
    lifecycle_grant::grant(
        &pool,
        *f.principal.org_id.as_uuid(),
        *f.principal.user_id.as_uuid(),
    )
    .await;
    let granted = page(&f, employee, LifecycleEventsQuery::default()).await;
    assert_eq!(granted["items"][0]["action_refusals"], json!({}));
    f.hr.rescind_lifecycle_event(
        f.principal.clone(),
        employee,
        latest,
        serde_json::from_value(json!({"reason_code":"INPUT_ERROR", "note":"회귀 검증"})).unwrap(),
    )
    .await
    .unwrap();
}
