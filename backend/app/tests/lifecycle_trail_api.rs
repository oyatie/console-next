// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Every refusal crosses the deployed HTTP router as problem details.

#[path = "../../crates/hr/adapter-postgres/tests/emp_create/fixture.rs"]
#[allow(dead_code)]
mod fixture;
#[path = "support/http.rs"]
mod http;

use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn composer_preview_uses_event_template_variant_and_register_review(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let ctx = http::ctx(
        &pool,
        *f.principal.org_id.as_uuid(),
        f.principal.user_id,
        &["SUPER_ADMIN"],
        None,
    )
    .await;
    let date = http::today_kst();
    for (variant, expected) in [("", 0), ("&variant=WORKPLACE_CHANGE", 4)] {
        let (status, body) = ctx
            .call(
                "GET",
                &format!(
                    "/api/v1/lifecycle-case-templates/TRANSFER?effective_date={date}{variant}"
                ),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let filings: Vec<_> = body
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["kind"] == "FIL")
            .collect();
        assert_eq!(filings.len(), expected);
        for item in filings {
            assert_eq!(item["legal_review_required"], true);
            assert_eq!(item["filing_kind"], "CHANGE");
            assert!(item["opens_rule_ref"].is_string());
            assert_eq!(item["opens_on"], date);
            assert!(item["due_on"].is_null());
            assert_eq!(item["due_disposition"], "UNKNOWN");
        }
    }
    let (status, body) = ctx
        .call(
            "GET",
            "/api/v1/lifecycle-case-templates/EXIT?exit_reason=PERSONAL",
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let items = body.as_array().unwrap();
    assert!(items.iter().any(|item| item["item_key"] == "RS1"));
    assert!(!items.iter().any(|item| item["item_key"] == "GT1"));
}

async fn refusal(pool: PgPool, code: &str) {
    let f = fixture::fixture(pool.clone()).await;
    let employee = f
        .create(f.body("http-refusal", "REGULAR"))
        .await
        .unwrap()
        .employee_id();
    let org = *f.principal.org_id.as_uuid();
    let case = Uuid::new_v4();
    let pending = code == "window_not_open";
    // A structural fixture works on N-1 too, so base failures prove missing REST behavior.
    sqlx::query("INSERT INTO lifecycle_cases (org_id,id,kind,subject_kind,employee_id,branch_id,trigger_kind,effective_date,template_key,template_version) \
        VALUES ($1,$2,'EXIT','EMPLOYMENT',$3,$4,'SCHEDULE',current_date,'EXIT',1)")
        .bind(org).bind(case).bind(employee).bind(f.branch).execute(&pool).await.unwrap();
    let item: Uuid = sqlx::query_scalar("INSERT INTO lifecycle_case_items (org_id,case_id,item_key,source,label_ko,kind,venue,mode,owner_line,due_disposition,status,blocks_close,legal) \
        VALUES ($1,$2,'AH1','AD_HOC','서류 확인','DOC','OUTSIDE',$3,$4,'UNKNOWN',$5,true,false) RETURNING id")
        .bind(org).bind(case).bind(if pending {"REQUESTED"} else {"ATTESTED"})
        .bind(if code == "owner_line" {None} else {Some("hr_basic.edit")})
        .bind(if pending {"PENDING_TRIGGER"} else {"OPEN"}).fetch_one(&pool).await.unwrap();
    if code == "self_completion" {
        sqlx::query("UPDATE users SET employee_id=$2 WHERE id=$1")
            .bind(f.principal.user_id.as_uuid())
            .bind(employee)
            .execute(&pool)
            .await
            .unwrap();
    }
    let ctx = http::ctx(&pool, org, f.principal.user_id, &["SUPER_ADMIN"], None).await;
    let mut body = json!({"expected_version":1});
    if code == "evidence_required" {
        body["observed_ref"] = json!("synthetic-receipt-000");
    }
    if code == "deadline_unknown" {
        body["due_date"] = json!(http::today_kst());
    }
    let uri = if code == "close_blocked" {
        format!("/api/v1/lifecycle-cases/{case}/close")
    } else {
        format!("/api/v1/lifecycle-cases/{case}/items/{item}/complete")
    };
    let (status, problem) = ctx.call("POST", &uri, Some(body)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{problem}");
    let expected = format!("lifecycle.refuse.{code}");
    assert_eq!(problem["error"]["code"], expected);
    assert_eq!(problem["type"], "about:blank");
    let unchanged: (String, Option<Value>, Option<time::Date>) = sqlx::query_as(
        "SELECT status,observed_ref,due_date FROM lifecycle_case_items WHERE org_id=$1 AND id=$2",
    )
    .bind(org)
    .bind(item)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        unchanged,
        (
            if pending { "PENDING_TRIGGER" } else { "OPEN" }.into(),
            None,
            None
        )
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn window_not_open(pool: PgPool) {
    refusal(pool, "window_not_open").await;
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn self_completion(pool: PgPool) {
    refusal(pool, "self_completion").await;
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn owner_line(pool: PgPool) {
    refusal(pool, "owner_line").await;
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn evidence_required(pool: PgPool) {
    refusal(pool, "evidence_required").await;
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn empty_completion_requires_evidence_and_leaves_item_unchanged(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let mut hire = f.body("http-empty-completion", "REGULAR");
    hire.hire_date = Some(http::today_kst().to_string());
    let employee = f.create(hire).await.unwrap().employee_id();
    let case =
        f.hr.employee_lifecycle_cases(f.principal.clone(), employee)
            .await
            .unwrap()
            .remove(0);
    let item = case
        .items
        .iter()
        .find(|item| item.item_key == "D1")
        .unwrap();
    let org = *f.principal.org_id.as_uuid();
    let ctx = http::ctx(&pool, org, f.principal.user_id, &["SUPER_ADMIN"], None).await;
    let (status, problem) = ctx
        .call(
            "POST",
            &format!(
                "/api/v1/lifecycle-cases/{}/items/{}/complete",
                case.id, item.id
            ),
            Some(json!({"expected_version":item.version})),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        problem["error"]["code"],
        "lifecycle.refuse.evidence_required"
    );
    let unchanged: (String, Option<Value>, i64) = sqlx::query_as(
        "SELECT status,observed_ref,version FROM lifecycle_case_items WHERE org_id=$1 AND id=$2",
    )
    .bind(org)
    .bind(item.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(unchanged, ("OPEN".into(), None, item.version));
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn close_blocked(pool: PgPool) {
    refusal(pool, "close_blocked").await;
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn deadline_unknown(pool: PgPool) {
    refusal(pool, "deadline_unknown").await;
}
