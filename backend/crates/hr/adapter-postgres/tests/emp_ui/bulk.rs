//! Dated bulk 승진 · 계약 갱신 (EMP-UI 8, 11): the preview's exact counts,
//! the one-batch commit, and the batch undo that takes back reservations.

use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::lifecycle::requests::BulkEmployeeLifecycleEventRequest;
use console_hr_adapter_postgres::lifecycle::void::RescindLifecycleEventRequest;
use console_kernel_core::BranchScope;
use console_platform_authz::{Feature, Principal};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{Fixture, fixture, status, uuid};

fn body(extra: Value) -> BulkEmployeeLifecycleEventRequest {
    let mut b = json!({"comment": "정기 인사"});
    b.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(b).unwrap()
}

fn promote(ids: &[Uuid], on: &str) -> BulkEmployeeLifecycleEventRequest {
    body(
        json!({"event_type": "PROMOTE", "employee_ids": ids, "to_position": "과장", "effective_date": on}),
    )
}

fn undo(confirm: bool, code: &str) -> RescindLifecycleEventRequest {
    serde_json::from_value(json!({"reason_code": code, "confirm_cascades": confirm})).unwrap()
}

async fn commit(f: &Fixture, b: BulkEmployeeLifecycleEventRequest) -> Result<Value, HrError> {
    f.hr.bulk_lifecycle_events(f.ops.clone(), Uuid::new_v4().to_string(), b)
        .await
}

async fn states(f: &Fixture) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT state FROM employee_lifecycle_events WHERE org_id = $1 ORDER BY employee_id",
    )
    .bind(f.org)
    .fetch_all(&f.owner)
    .await
    .unwrap()
}

/// A CONTRACT employee hired on `hire` whose current contract runs `from`..`to`.
async fn contract(f: &Fixture, hire: &str, from: &str, to: &str) -> Uuid {
    let id = f.employee().await;
    sqlx::query("UPDATE employees SET hire_date = $2::DATE WHERE id = $1")
        .bind(id)
        .bind(hire)
        .execute(&f.owner)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO employee_employment_profiles (employee_id, org_id, employment_type, \
         phone_e164, base_pay, idempotency_key, request_hash, created_by, \
         contract_start_date, contract_end_date) \
         VALUES ($1, $2, 'CONTRACT', '+821012345678', 3000000, $3, $4, $5, $6::DATE, $7::DATE)",
    )
    .bind(id)
    .bind(f.org)
    .bind(Uuid::new_v4().to_string())
    .bind("0".repeat(64))
    .bind(f.user)
    .bind(from)
    .bind(to)
    .execute(&f.owner)
    .await
    .unwrap();
    id
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_dated_promotion_previews_its_exact_counts_then_reserves_everyone(pool: PgPool) {
    let f = fixture(pool, true).await;
    let ids = [f.employee().await, f.employee().await, f.employee().await];
    let preview =
        f.hr.preview_bulk_lifecycle_events(f.ops.clone(), promote(&ids, "2027-03-01"))
            .await
            .unwrap();
    assert!(preview.scheduled);
    assert_eq!(
        serde_json::to_value(&preview.counts).unwrap(),
        json!({"selected": 3, "will_apply": 0, "will_schedule": 3, "refused": 0})
    );
    // The preview writes and audits nothing.
    assert_eq!(f.count("employee_lifecycle_events").await, 0);
    assert_eq!(f.audits("employee.lifecycle.bulk").await, 0);
    let done = commit(&f, promote(&ids, "2027-03-01")).await.unwrap();
    let batch = done["batch_id"].clone();
    assert!(
        done["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["state"] == "SCHEDULED" && i["batch_id"] == batch)
    );
    assert_eq!(states(&f).await, ["SCHEDULED"; 3]);
    assert_eq!(f.audits("employee.lifecycle.bulk").await, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_bulk_renewal_runs_the_two_year_rule_per_person_all_or_nothing(pool: PgPool) {
    let f = fixture(pool, true).await;
    let short = contract(&f, "2026-01-02", "2026-01-02", "2026-06-30").await;
    let long = contract(&f, "2023-01-02", "2023-01-02", "2026-06-30").await;
    let renew = |ids: &[Uuid]| {
        body(
            json!({"event_type": "CONTRACT_RENEWAL", "employee_ids": ids,
                    "contract_end_date": "2026-12-31", "effective_date": "2026-07-01"}),
        )
    };
    let preview =
        f.hr.preview_bulk_lifecycle_events(f.ops.clone(), renew(&[short, long]))
            .await
            .unwrap();
    assert_eq!(
        serde_json::to_value(&preview.counts).unwrap(),
        json!({"selected": 2, "will_apply": 1, "will_schedule": 0, "refused": 1})
    );
    assert_eq!(preview.refusals[0]["employee_id"], json!(long));
    assert_eq!(preview.refusals[0]["code"], "fixed_term_limit");
    // The commit refuses the whole batch with the same refusal; nothing moves.
    let refused = commit(&f, renew(&[short, long])).await.unwrap_err();
    assert_eq!(status(&refused), (422, "bulk_lifecycle_refused"));
    assert_eq!(refused.refusals.unwrap()[0]["code"], "fixed_term_limit");
    assert_eq!(f.count("employee_lifecycle_events").await, 0);
    assert_eq!(f.audits("employee.lifecycle.bulk").await, 0);
    let end: String = sqlx::query_scalar(
        "SELECT contract_end_date::TEXT FROM employee_employment_profiles WHERE employee_id = $1",
    )
    .bind(short)
    .fetch_one(&f.owner)
    .await
    .unwrap();
    assert_eq!(end, "2026-06-30");
    commit(&f, renew(&[short])).await.unwrap();
    let end: String = sqlx::query_scalar(
        "SELECT contract_end_date::TEXT FROM employee_employment_profiles WHERE employee_id = $1",
    )
    .bind(short)
    .fetch_one(&f.owner)
    .await
    .unwrap();
    assert_eq!(end, "2026-12-31");
}

/// Regression (BE-EMP-UI, EMP-UI 8/11): on 3c988fc2 the batch undo read only
/// APPLIED events, so a dated (future) batch could not be taken back as one:
/// 404 `not_found`, its reservations left standing.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_a_dated_batch_is_undone_as_one(pool: PgPool) {
    let f = fixture(pool, true).await;
    let ids = [f.employee().await, f.employee().await];
    let done = commit(&f, promote(&ids, "2027-03-01")).await.unwrap();
    let batch = uuid(&done["batch_id"]);
    // Without confirm_cascades it only checks: nothing changes, no audit.
    f.hr.rescind_lifecycle_batch(f.ops.clone(), batch, undo(false, "PLAN_WITHDRAWN"))
        .await
        .unwrap();
    assert_eq!(states(&f).await, ["SCHEDULED"; 2]);
    let undone =
        f.hr.rescind_lifecycle_batch(f.ops.clone(), batch, undo(true, "PLAN_WITHDRAWN"))
            .await
            .unwrap();
    assert_eq!(undone.len(), 2);
    assert_eq!(states(&f).await, ["CANCELLED"; 2]);
    assert_eq!(f.audits("employee.lifecycle.bulk_rescind").await, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_batch_undo_refuses_a_bad_reason_an_unknown_batch_and_a_second_undo(pool: PgPool) {
    let f = fixture(pool, true).await;
    let ids = [f.employee().await];
    let batch = uuid(&commit(&f, promote(&ids, "2027-03-01")).await.unwrap()["batch_id"]);
    let bad =
        f.hr.rescind_lifecycle_batch(f.ops.clone(), batch, undo(true, "NOT_A_CODE"))
            .await
            .unwrap_err();
    assert_eq!(status(&bad), (422, "reason_code_invalid"));
    let unknown =
        f.hr.rescind_lifecycle_batch(f.ops.clone(), Uuid::new_v4(), undo(true, "PLAN_WITHDRAWN"))
            .await
            .unwrap_err();
    assert_eq!(status(&unknown).0, 404);
    assert_eq!(states(&f).await, ["SCHEDULED"]);
    f.hr.rescind_lifecycle_batch(f.ops.clone(), batch, undo(true, "PLAN_WITHDRAWN"))
        .await
        .unwrap();
    let again =
        f.hr.rescind_lifecycle_batch(f.ops.clone(), batch, undo(true, "PLAN_WITHDRAWN"))
            .await
            .unwrap_err();
    assert_eq!(status(&again).0, 404);
    assert_eq!(f.audits("employee.lifecycle.bulk_rescind").await, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_preview_keeps_the_commits_gate_and_request_rules(pool: PgPool) {
    let f = fixture(pool, true).await;
    let ids = [f.employee().await];
    let reader: Principal = f
        .granted(Feature::EmployeeDirectoryRead, BranchScope::All)
        .await;
    let denied =
        f.hr.preview_bulk_lifecycle_events(reader, promote(&ids, "2027-03-01"))
            .await
            .unwrap_err();
    assert_eq!(status(&denied), (403, "forbidden"));
    for bad in [
        {
            // Built with a valid kind and then set: the wire validator refuses this kind before
            // the domain, and the case exercises the domain's own refusal.
            let mut b = body(
                json!({"event_type": "TRANSFER", "employee_ids": ids, "effective_date": "2027-03-01"}),
            );
            b.event_type = "LEAVE_OF_ABSENCE".into();
            b
        },
        body(
            json!({"event_type": "PROMOTE", "employee_ids": [], "to_position": "x", "effective_date": "2027-03-01"}),
        ),
        body(
            json!({"event_type": "PROMOTE", "employee_ids": [ids[0], ids[0]], "to_position": "x", "effective_date": "2027-03-01"}),
        ),
        body(
            json!({"event_type": "CONTRACT_RENEWAL", "employee_ids": ids, "effective_date": "2027-03-01"}),
        ),
        body(
            json!({"event_type": "PROMOTE", "employee_ids": ids, "to_position": "x", "effective_date": "2027-13-01"}),
        ),
    ] {
        let refused =
            f.hr.preview_bulk_lifecycle_events(f.ops.clone(), bad)
                .await
                .unwrap_err();
        assert_eq!(status(&refused).0, 422);
    }
    assert_eq!(f.count("employee_lifecycle_events").await, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_replayed_commit_is_one_batch_and_a_reused_key_is_refused(pool: PgPool) {
    let f = fixture(pool, false).await;
    let ids = [f.employee().await];
    let key = Uuid::new_v4().to_string();
    // SETUP: a promotion is not phase-bound (decisions #26 records it).
    let first =
        f.hr.bulk_lifecycle_events(f.ops.clone(), key.clone(), promote(&ids, "2027-03-01"))
            .await
            .unwrap();
    let again =
        f.hr.bulk_lifecycle_events(f.ops.clone(), key.clone(), promote(&ids, "2027-03-01"))
            .await
            .unwrap();
    assert_eq!(first, again);
    assert_eq!(f.count("employee_lifecycle_events").await, 1);
    let other =
        f.hr.bulk_lifecycle_events(f.ops.clone(), key, promote(&ids, "2027-04-01"))
            .await
            .unwrap_err();
    assert_eq!(status(&other).0, 409);
    assert_eq!(f.count("employee_lifecycle_events").await, 1);
    assert_eq!(f.audits("employee.lifecycle.bulk").await, 1);
}
