// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The composer selects the same effective-dated rules and windows as its case.
#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;
use console_hr_adapter_postgres::{cases::TemplatePreviewQuery, clock::today_kst};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Date, Duration};

async fn preview(f: &fixture::Fixture, key: &str, on: Option<Date>) -> Vec<Value> {
    f.hr.lifecycle_template_preview_for(
        f.principal.clone(),
        key.into(),
        TemplatePreviewQuery {
            effective_date: on,
            ..Default::default()
        },
    )
    .await
    .unwrap()
    .iter()
    .map(|item| serde_json::to_value(item).unwrap())
    .collect()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn dated_preview_matches_case_windows_and_undated_preview_describes_register_rules(
    pool: PgPool,
) {
    let f = fixture::fixture(pool).await;
    let on = today_kst();
    let mut body = f.body("preview-window", "REGULAR");
    body.hire_date = Some(on.to_string());
    let employee = f.create(body).await.unwrap().employee_id();
    let case =
        f.hr.employee_lifecycle_cases(f.principal.clone(), employee)
            .await
            .unwrap()
            .remove(0);
    let dated = preview(&f, "ONBOARD", Some(on)).await;
    for item in &case.items {
        let row = dated
            .iter()
            .find(|row| row["item_key"] == item.item_key)
            .unwrap();
        assert!(
            row.get("opens_on").is_some(),
            "preview window is absent: {row}"
        );
        assert_eq!(row["opens_on"], json!(item.opens_on));
        assert_eq!(row["due_on"], json!(item.due_date));
        assert_eq!(row["due_in_days"], json!(item.due_in_days));
        assert_eq!(row["due_disposition"], item.due_disposition);
    }
    let undated = preview(&f, "ONBOARD", None).await;
    let filing = undated.iter().find(|row| row["insurer"] == "EI").unwrap();
    assert!(filing["opens_on"].is_null());
    assert!(filing["due_on"].is_null());
    assert_eq!(filing["opens_anchor"], "ACQUIRE_DATE");
    assert_eq!(filing["due_rule_kind"], "DAY_OF_NEXT_MONTH");
    assert!(filing["due_rule_value"].is_number());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn template_versions_obey_both_effective_date_boundaries(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let boundary = today_kst() + Duration::days(30);
    let end = boundary + Duration::days(30);
    sqlx::query("UPDATE case_templates SET effective_to_exclusive=$1 WHERE template_key='HIRE'")
        .bind(boundary)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO case_templates SELECT (jsonb_populate_record(NULL::case_templates,to_jsonb(t)||jsonb_build_object(\
        'version',2,'effective_from',$1::date,'effective_to_exclusive',$2::date))).* FROM case_templates t WHERE template_key='HIRE' AND version=1")
        .bind(boundary).bind(end).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO case_template_items SELECT (jsonb_populate_record(NULL::case_template_items,to_jsonb(t)||jsonb_build_object(\
        'version',2,'label_ko','새 입사 서류'))).* FROM case_template_items t WHERE template_key='HIRE' AND version=1")
        .execute(&pool).await.unwrap();
    let before = preview(&f, "ONBOARD", Some(boundary - Duration::days(1))).await;
    assert!(!before.is_empty());
    assert!(before.iter().all(|row| row["label"] != "새 입사 서류"));
    let after = preview(&f, "ONBOARD", Some(boundary)).await;
    assert_eq!(after.len(), before.len());
    assert!(after.iter().all(|row| row["label"] == "새 입사 서류"));
    assert!(preview(&f, "ONBOARD", Some(end)).await.is_empty());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn register_versions_select_opening_and_deadline_by_effective_date(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let boundary: Date = sqlx::query_scalar("SELECT greatest(current_date,max(effective_from))+30 FROM statutory_rules WHERE code='ins.deadline.acquire.nhis'")
        .fetch_one(&pool).await.unwrap();
    let end = boundary + Duration::days(30);
    sqlx::query("UPDATE statutory_rules SET effective_to_exclusive=$1,filing_rule=jsonb_set(filing_rule,'{effective_to_exclusive}',to_jsonb($1::date::text)) WHERE code='ins.deadline.acquire.nhis' AND effective_to_exclusive IS NULL")
        .bind(boundary).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO statutory_rules SELECT (jsonb_populate_record(NULL::statutory_rules,to_jsonb(r)||jsonb_build_object(\
        'effective_from',$1::date,'effective_to_exclusive',$2::date,'value_num',19,\
        'filing_rule',r.filing_rule||jsonb_build_object('effective_from',$1::text,'effective_to_exclusive',$2::text,'opens_offset',2,\
          'deadline',(r.filing_rule->'deadline')||jsonb_build_object('value',19))))).* \
        FROM statutory_rules r WHERE code='ins.deadline.acquire.nhis' AND effective_to_exclusive=$1")
        .bind(boundary).bind(end).execute(&pool).await.unwrap();
    for (on, offset, days, value) in [
        (boundary - Duration::days(1), 0, 13, 14),
        (boundary, 2, 18, 19),
    ] {
        let rows = preview(&f, "ONBOARD", Some(on)).await;
        let row = rows.iter().find(|row| row["insurer"] == "NHIS").unwrap();
        assert_eq!(row["opens_on"], (on + Duration::days(offset)).to_string());
        assert_eq!(row["due_on"], (on + Duration::days(days)).to_string());
        assert_eq!(row["due_rule_value"], value);
        assert_eq!(row["opens_offset_days"], offset);
    }
    let expired = preview(&f, "ONBOARD", Some(end)).await;
    let row = expired
        .iter()
        .find(|row| row["rule_ref"] == "ins.deadline.acquire.nhis")
        .unwrap();
    assert_eq!(row["due_disposition"], "UNKNOWN");
    assert!(row["due_on"].is_null());
    assert!(row["due_rule_value"].is_null());
}

async fn start_operations(pool: &PgPool, f: &fixture::Fixture) {
    sqlx::query("UPDATE tenant_phase SET phase='OPERATING',go_live_at=now(),go_live_by=$2,go_live_preview_digest=repeat('0',64) WHERE org_id=$1")
        .bind(f.principal.org_id.as_uuid()).bind(f.principal.user_id.as_uuid())
        .execute(pool).await.unwrap();
}

async fn assert_historical_preview(f: &fixture::Fixture, employee: uuid::Uuid, on: Date) {
    let rows = preview(f, "ONBOARD", Some(on)).await;
    let cases =
        f.hr.employee_lifecycle_cases(f.principal.clone(), employee)
            .await
            .unwrap();
    let filings: Vec<_> = cases[0]
        .items
        .iter()
        .filter(|item| item.kind == "FIL")
        .collect();
    assert_eq!(filings.len(), 4);
    for item in filings {
        let row = rows
            .iter()
            .find(|row| row["item_key"] == item.item_key)
            .unwrap();
        assert_eq!(item.status, "NOT_APPLICABLE");
        assert_eq!(item.status_code.as_deref(), Some("PRE_CONSOLE"));
        assert_eq!(row["due_disposition"], item.status_code.as_deref().unwrap());
        for field in ["opens_on", "opens_in_days", "due_on", "due_in_days"] {
            assert!(row[field].is_null(), "historic preview has a window: {row}");
        }
        assert!(item.opens_on.is_none());
        assert!(item.due_date.is_none());
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn past_hire_preview_matches_pre_console_case_after_go_live(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    start_operations(&pool, &f).await;
    let on = today_kst() - Duration::days(90);
    let mut body = f.body("operating-past-hire-preview", "REGULAR");
    body.hire_date = Some(on.to_string());
    let employee = f.create(body).await.unwrap().employee_id();
    assert_historical_preview(&f, employee, on).await;
    let boundary = preview(&f, "ONBOARD", Some(today_kst())).await;
    assert!(
        boundary
            .iter()
            .filter(|row| row["kind"] == "FIL")
            .all(|row| row["due_disposition"] != "PRE_CONSOLE" && row["opens_on"].is_string())
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn setup_hire_preview_and_case_follow_the_same_unset_then_committed_go_live(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let on = today_kst() - Duration::days(90);
    let mut body = f.body("setup-past-hire-preview", "REGULAR");
    body.hire_date = Some(on.to_string());
    let employee = f.create(body).await.unwrap().employee_id();
    assert_historical_preview(&f, employee, on).await;
    let future = preview(&f, "ONBOARD", Some(today_kst() + Duration::days(1))).await;
    assert!(
        future
            .iter()
            .filter(|row| row["kind"] == "FIL")
            .all(|row| row["due_disposition"] != "PRE_CONSOLE" && row["opens_on"].is_string())
    );
    start_operations(&pool, &f).await;
    assert_historical_preview(&f, employee, on).await;
}
