// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Every refusal leaves the lifecycle item open and its case intact.

#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;

use std::collections::BTreeSet;

use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::cases::LifecycleCase;
use console_hr_adapter_postgres::clock::today_kst;
use console_kernel_core::{BranchScope, UserId};
use console_platform_authz::{EffectiveFeatureGrant, Feature, PermissionLevel, Principal, Role};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::Duration;

async fn hire(pool: PgPool, future: bool) -> (fixture::Fixture, LifecycleCase) {
    let f = fixture::fixture(pool).await;
    let mut body = f.body("lifecycle-refusal-hire", "REGULAR");
    let on = today_kst() + Duration::days(i64::from(future));
    body.hire_date = Some(on.to_string());
    let employee = f.create(body).await.unwrap().employee_id();
    let case =
        f.hr.employee_lifecycle_cases(f.principal.clone(), employee)
            .await
            .unwrap()
            .into_iter()
            .find(|case| case.kind == "HIRE")
            .unwrap();
    (f, case)
}

async fn complete_document(
    f: &fixture::Fixture,
    principal: Principal,
    case: &LifecycleCase,
    observed_ref: Option<Value>,
) -> HrError {
    let item = case.items.iter().find(|item| item.kind == "DOC").unwrap();
    f.hr.complete_lifecycle_item(
        principal,
        case.id,
        item.id,
        serde_json::from_value(json!({
            "expected_version": item.version,
            "observed_ref": observed_ref,
            "exception_id": null,
            "waive": false,
            "reason": null
        }))
        .unwrap(),
    )
    .await
    .unwrap_err()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn future_event_refuses_item_completion_before_its_window(pool: PgPool) {
    let (f, case) = hire(pool, true).await;
    let error = complete_document(&f, f.principal.clone(), &case, None).await;
    assert_eq!(error.code, "lifecycle.refuse.window_not_open");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn empty_completion_requires_evidence_and_leaves_item_unchanged(pool: PgPool) {
    let (f, case) = hire(pool, false).await;
    let item = case
        .items
        .iter()
        .find(|item| item.item_key == "D1")
        .unwrap();
    let error =
        f.hr.complete_lifecycle_item(
            f.principal.clone(),
            case.id,
            item.id,
            serde_json::from_value(json!({"expected_version":item.version})).unwrap(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "lifecycle.refuse.evidence_required");
    let after =
        f.hr.lifecycle_case(f.principal.clone(), case.id)
            .await
            .unwrap();
    let unchanged = after.items.iter().find(|row| row.id == item.id).unwrap();
    assert_eq!(unchanged.status, "OPEN");
    assert_eq!(unchanged.version, item.version);
    assert!(unchanged.observed_ref.is_none());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn subject_refuses_completion_even_with_the_owner_permission(pool: PgPool) {
    let (f, case) = hire(pool.clone(), false).await;
    sqlx::query("UPDATE users SET employee_id = $3 WHERE org_id = $1 AND id = $2")
        .bind(f.principal.org_id.as_uuid())
        .bind(f.principal.user_id.as_uuid())
        .bind(case.employee_id)
        .execute(&pool)
        .await
        .unwrap();
    let error = complete_document(&f, f.principal.clone(), &case, None).await;
    assert_eq!(error.code, "lifecycle.refuse.self_completion");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reader_refuses_completion_without_the_item_owner_line(pool: PgPool) {
    let (f, case) = hire(pool.clone(), false).await;
    let user = UserId::new();
    sqlx::query("INSERT INTO users (id,org_id,display_name,roles) VALUES ($1,$2,'이력 열람자',$3)")
        .bind(user.as_uuid())
        .bind(f.principal.org_id.as_uuid())
        .bind(["MEMBER"])
        .execute(&pool)
        .await
        .unwrap();
    let reader = Principal::new(
        user,
        f.principal.org_id,
        BTreeSet::from([Role::Member]),
        BranchScope::All,
    )
    .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
        Feature::EmployeeDirectoryRead,
        PermissionLevel::Allow,
        BranchScope::All,
    )]);
    let error = complete_document(&f, reader, &case, None).await;
    assert_eq!(error.code, "lifecycle.refuse.owner_line");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn free_text_refuses_evidence_completion(pool: PgPool) {
    let (f, case) = hire(pool, false).await;
    let error = complete_document(
        &f,
        f.principal.clone(),
        &case,
        Some(json!("synthetic-receipt-000")),
    )
    .await;
    assert_eq!(error.code, "lifecycle.refuse.evidence_required");
    let unchanged =
        f.hr.lifecycle_case(f.principal.clone(), case.id)
            .await
            .unwrap();
    assert_eq!(unchanged.state, "OPEN");
    assert_eq!(
        unchanged
            .items
            .iter()
            .find(|item| item.kind == "DOC")
            .unwrap()
            .status,
        "OPEN"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn blocking_open_item_refuses_case_close(pool: PgPool) {
    let (f, case) = hire(pool, false).await;
    assert!(
        case.items
            .iter()
            .any(|item| item.blocks_close && item.status == "OPEN")
    );
    let error =
        f.hr.close_lifecycle_case(f.principal.clone(), case.id)
            .await
            .unwrap_err();
    assert_eq!(error.code, "lifecycle.refuse.close_blocked");
    assert_eq!(
        f.hr.lifecycle_case(f.principal.clone(), case.id)
            .await
            .unwrap()
            .state,
        "OPEN"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unknown_deadline_refuses_a_client_supplied_date(pool: PgPool) {
    let (f, case) = hire(pool.clone(), false).await;
    let item = case
        .items
        .iter()
        .find(|item| item.due_disposition == "UNKNOWN" && item.status == "OPEN")
        .unwrap();
    assert!(item.due_date.is_none());
    let error =
        f.hr.complete_lifecycle_item(
            f.principal.clone(),
            case.id,
            item.id,
            serde_json::from_value(
                json!({"expected_version":item.version,"observed_ref":null,"exception_id":null,
            "waive":false,"reason":null,"due_date":today_kst().to_string()}),
            )
            .unwrap(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "lifecycle.refuse.deadline_unknown");
    let stored: Option<time::Date> =
        sqlx::query_scalar("SELECT due_date FROM lifecycle_case_items WHERE org_id=$1 AND id=$2")
            .bind(f.principal.org_id.as_uuid())
            .bind(item.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(stored.is_none());
}
