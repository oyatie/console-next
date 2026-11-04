// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_compliance_adapter_postgres::{
    PgComplianceStore,
    rights::{self, Filing},
};
use console_kernel_core::OrgId;
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

fn filing(controller: &str, kinds: &[&str], detail: &str) -> Filing {
    serde_json::from_value(json!({"controller":controller,"kinds":kinds,"detail":detail})).unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn filing_is_atomic_keyset_paged_and_uses_the_register(pool: PgPool) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "privacy").await;
    let rt = runtime_role_pool(&pool).await;
    let store = PgComplianceStore::new(rt.clone());
    let mut tx = rights::begin(&rt, org).await.unwrap();
    // A changed reference value must reach the persisted per-kind clock.
    sqlx::query("UPDATE statutory_rules SET value_num=17 WHERE code='PIPA_ACCESS_RESPONSE_DAYS'")
        .execute(&pool)
        .await
        .unwrap();
    let register = store.statutory_register().await.unwrap();
    let input = filing("OPERATOR", &["ACCESS", "WITHDRAWAL"], "My account");
    let record = rights::file(&mut tx, org, user, None, &input, &register)
        .await
        .unwrap();
    let due = &record["kinds"]["ACCESS"]["due"]["on"];
    let received = time::Date::parse(
        record["receipt"]["received_on"].as_str().unwrap(),
        time::macros::format_description!("[year]-[month]-[day]"),
    )
    .unwrap();
    assert_eq!(due, &(received + time::Duration::days(17)).to_string());
    assert_eq!(record["kinds"]["WITHDRAWAL"]["due"]["without_delay"], true);
    let id = Uuid::parse_str(record["id"].as_str().unwrap()).unwrap();
    assert_eq!(record["receipt"]["identity_method"], "PASSKEY");
    let second = rights::file(&mut tx, org, user, None, &input, &register)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = rights::begin(&rt, org).await.unwrap();
    let page = rights::mine(&mut tx, user, None, 1).await.unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    let cursor = page["next_cursor"].as_str().unwrap();
    let next = rights::mine(&mut tx, user, Some(cursor), 1).await.unwrap();
    assert_eq!(next["items"].as_array().unwrap().len(), 1);
    assert!(next["next_cursor"].is_null());
    assert_ne!(page["items"][0]["id"], next["items"][0]["id"]);
    assert!([record.clone(), second].contains(&page["items"][0]));
    assert_eq!(
        rights::mine(&mut tx, console_kernel_core::UserId::new(), None, 1)
            .await
            .unwrap()["items"],
        json!([])
    );
    tx.rollback().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE target_id=$1 AND action='privacy_request.received'")
        .bind(id.to_string()).fetch_one(&pool).await.unwrap();
    assert_eq!(count, 1);
    let foreign = OrgId::new();
    seed_org_and_super_admin(&pool, *foreign.as_uuid(), "other").await;
    let mut tx = rights::begin(&rt, foreign).await.unwrap();
    assert_eq!(
        rights::mine(&mut tx, user, None, 1).await.unwrap()["items"],
        json!([])
    );
    tx.rollback().await.unwrap();
    let mut tx = rights::begin(&rt, org).await.unwrap();
    let rollback = rights::file(&mut tx, org, user, None, &input, &register)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    let absent: Option<Value> =
        sqlx::query_scalar("SELECT body FROM privacy_rights_requests WHERE id=$1")
            .bind(Uuid::parse_str(rollback["id"].as_str().unwrap()).unwrap())
            .fetch_optional(&pool)
            .await
            .unwrap();
    assert!(absent.is_none());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn filing_refusals_leave_no_request_or_audit(pool: PgPool) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "refusals").await;
    let rt = runtime_role_pool(&pool).await;
    let register = PgComplianceStore::new(rt.clone())
        .statutory_register()
        .await
        .unwrap();
    for (input, code) in [
        (filing("TENANT", &["ACCESS"], ""), "no_employee_record"),
        (filing("OPERATOR", &[], ""), "request_kind_required"),
        (
            filing("OPERATOR", &["AUTOMATED_DECISION"], ""),
            "request_kind_unavailable",
        ),
        (
            filing("OPERATOR", &["TRANSMISSION"], ""),
            "request_kind_unavailable",
        ),
        (
            filing("OPERATOR", &["ACCESS"], &"a".repeat(2001)),
            "detail_too_long",
        ),
    ] {
        let mut tx = rights::begin(&rt, org).await.unwrap();
        let error = rights::file(&mut tx, org, user, None, &input, &register)
            .await
            .unwrap_err();
        assert!(error.to_string().contains(code), "{error}");
        let console_compliance_adapter_postgres::PgComplianceError::Domain(refusal) = error else {
            panic!("domain refusal expected")
        };
        assert_eq!(refusal.code, Some(code));
        tx.rollback().await.unwrap();
    }
    let mut tx = rights::begin(&rt, org).await.unwrap();
    assert!(
        rights::mine(&mut tx, user, Some("invalid"), 1)
            .await
            .unwrap_err()
            .to_string()
            .contains("cursor_invalid")
    );
    tx.rollback().await.unwrap();
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM privacy_rights_requests WHERE org_id=$1")
            .bind(org.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
}
