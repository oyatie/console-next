// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[path = "short_tenure/rules.rs"]
mod rules;
#[path = "short_tenure/service_dates.rs"]
mod service_dates;
use console_kernel_core::BranchScope;
use console_platform_authz::{EffectiveFeatureGrant, Feature, PermissionLevel, Principal, Role};
use std::collections::BTreeSet;

async fn prepared(pool: &PgPool, hire: &str, exit: &str) -> (World, Value) {
    let w = live(pool).await;
    sqlx::query("UPDATE employees SET hire_on=$2::text::date, hire_date=$2 WHERE id=$1")
        .bind(w.in_a)
        .bind(hire)
        .execute(pool)
        .await
        .unwrap();
    let c = report(&w, w.in_a, Some("PERSONAL"), exit).await.unwrap();
    let c = confirm(&w, &c, json!({})).await.unwrap();
    let c = confirm(&w, &c, json!({"hq_confirmation":true}))
        .await
        .unwrap();
    (w, c)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn same_day_hire_exit_submits_without_wage_sources(pool: PgPool) {
    let today = (time::OffsetDateTime::now_utc() + Duration::hours(9)).date();
    let (w, c) = prepared(&pool, &today.to_string(), &today.to_string()).await;
    let p = &c["settlement_package"];
    assert_eq!(
        p["statutory_basis"]["severance_eligibility"]["outcome"],
        "NOT_ELIGIBLE"
    );
    assert_eq!(
        p["statutory_basis"]["severance_eligibility"]["reason"],
        "UNDER_SERVICE_YEARS"
    );
    assert_eq!(
        p["statutory_basis"]["severance_eligibility"]["threshold"],
        json!({"num":1,"den":1})
    );
    assert_eq!(p["status"], "READY_FOR_APPROVAL");
    assert_eq!(c["status"], "SETTLEMENT_READY");
    let rule = &p["statutory_basis"]["calculation_references"]["rules"][0];
    assert_eq!(rule["code"], "SEVERANCE_MIN_SERVICE_YEARS");
    assert_eq!(rule["effective_from"], "2026-07-01");
    assert_eq!(rule["citation"]["instrument_ko"], "근로자퇴직급여 보장법");
    assert!(
        rule["citation"]["article_ko"]
            .as_str()
            .unwrap()
            .contains("제4조제1항")
    );
    assert_eq!(p["severance_pay_won"], 0);
    assert_eq!(p["missing_source_fields"], json!([]));
    assert_eq!(
        p["insurance_loss_payload"]["forms"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
    assert_eq!(p["certification_status"], "UNCERTIFIED_DRAFT");
    let decisions: Vec<Value> = sqlx::query_scalar("SELECT after_snap FROM audit_events WHERE org_id=$1 AND action='employee.exit.severance_eligibility'")
        .bind(w.org).fetch_all(&pool).await.unwrap();
    assert_eq!(decisions.len(), 2);
    for decision in decisions {
        assert_eq!(decision["outcome"], "NOT_ELIGIBLE");
        assert_eq!(decision["rule"]["instrument"], "근로자퇴직급여 보장법");
        assert_eq!(decision["review_required"], true);
    }
    w.hr.apply_due(today.next_day().unwrap()).await.unwrap();
    let id = c["id"].as_str().unwrap().parse().unwrap();
    let result =
        w.hr.draft_exit_approval(
            w.hr(w.hr_one),
            id,
            serde_json::from_value(json!({"submit":true})).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(result.status, "SUBMITTED");
    let p = result.settlement_package.unwrap();
    assert_eq!(
        p.approval_payload["tracking"]["insurance_loss_report"],
        true
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn service_threshold_uses_exit_dated_register_row(pool: PgPool) {
    sqlx::query("UPDATE statutory_rules SET value_num=2 WHERE code='SEVERANCE_MIN_SERVICE_YEARS' AND effective_from <= DATE '2026-10-13' AND (effective_to_exclusive IS NULL OR DATE '2026-10-13' < effective_to_exclusive)")
        .execute(&pool).await.unwrap();
    sqlx::query("UPDATE statutory_rules SET effective_to_exclusive=DATE '2026-10-14' WHERE code='SEVERANCE_MIN_SERVICE_YEARS' AND effective_from=DATE '2026-07-01'")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO statutory_rules SELECT (jsonb_populate_record(NULL::statutory_rules,to_jsonb(r)||jsonb_build_object('effective_from','2026-10-14','effective_to_exclusive',NULL,'value_num',3))).* FROM statutory_rules r WHERE code='SEVERANCE_MIN_SERVICE_YEARS' AND effective_from=DATE '2026-07-01'")
        .execute(&pool).await.unwrap();
    let (_, c) = prepared(&pool, "2025-10-14", "2026-10-13").await;
    let eligibility = &c["settlement_package"]["statutory_basis"]["severance_eligibility"];
    assert_eq!(eligibility["outcome"], "NOT_ELIGIBLE");
    assert_eq!(eligibility["threshold"], json!({"num":2,"den":1}));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn short_tenure_draft_refuses_other_tenant_and_lower_grant_without_writes(pool: PgPool) {
    let (w, c) = prepared(&pool, "2026-10-13", "2026-10-13").await;
    assert_eq!(c["settlement_package"]["severance_pay_won"], 0);
    let id: Uuid = c["id"].as_str().unwrap().parse().unwrap();
    let before: Value = sqlx::query_scalar("SELECT to_jsonb(p) FROM employee_exit_settlement_packages p WHERE org_id=$1 AND exit_case_id=$2")
        .bind(w.org).bind(id).fetch_one(&pool).await.unwrap();
    let other = support::tenant(&pool).await;
    let actor = support::user(&pool, other.org, None).await;
    let body = || serde_json::from_value(json!({"submit":false})).unwrap();
    let error = other
        .hr
        .draft_exit_approval(support::principal(other.org, actor), id, body())
        .await
        .unwrap_err();
    assert_eq!(error.code, "not_found");
    let reader_id = support::user(&pool, w.org, None).await;
    lifecycle_grant::grant_hr_basic(&pool, w.org, *reader_id.as_uuid(), &["view"]).await;
    let reader = Principal::new(
        reader_id,
        OrgId::from_uuid(w.org),
        BTreeSet::from([Role::Member]),
        BranchScope::All,
    )
    .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
        Feature::EmployeeDirectoryRead,
        PermissionLevel::Allow,
        BranchScope::All,
    )]);
    let error =
        w.hr.draft_exit_approval(reader, id, body())
            .await
            .unwrap_err();
    assert_eq!(error.code, "forbidden");
    let after: Value = sqlx::query_scalar("SELECT to_jsonb(p) FROM employee_exit_settlement_packages p WHERE org_id=$1 AND exit_case_id=$2")
        .bind(w.org).bind(id).fetch_one(&pool).await.unwrap();
    assert_eq!(after, before);
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM employee_exit_settlement_packages WHERE org_id=$1",
    )
    .bind(other.org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
}

fn wage_input() -> Value {
    json!({"average_wage_period_start":"2026-07-01","average_wage_period_end":"2026-09-30",
        "average_wage_calendar_days":92,"average_wage_total_won":9_200_000,"monthly_ordinary_wage_won":3_000_000})
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unknown_hire_does_not_claim_a_service_exclusion(pool: PgPool) {
    let (w, c) = prepared(&pool, "2026-10-13", "2026-10-13").await;
    let id = c["id"].as_str().unwrap().parse().unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET hire_on=NULL,hire_date=NULL WHERE id=$1")
        .bind(w.in_a)
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(
        "UPDATE employment_heads SET hire_date=NULL,severance_start_date=NULL WHERE employee_id=$1",
    )
    .bind(w.in_a)
    .execute(tx.as_mut())
    .await
    .unwrap();
    console_hr_adapter_postgres::exits::settlement_store::upsert_exit_settlement_package(
        &mut tx, w.org, id, None,
    )
    .await
    .unwrap();
    let p: Value = sqlx::query_scalar(
        "SELECT to_jsonb(p) FROM employee_exit_settlement_packages p WHERE exit_case_id=$1",
    )
    .bind(id)
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    assert_eq!(p["status"], "NEEDS_SOURCE");
    assert!(p["severance_pay_won"].is_null());
    assert!(p["statutory_basis"]["severance_eligibility"].is_null());
    assert!(
        p["missing_source_fields"]
            .as_array()
            .unwrap()
            .contains(&json!("hire_date"))
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn settlement_uses_linked_employment_instead_of_latest_employee_hire(pool: PgPool) {
    let (w, c) = prepared(&pool, "2026-10-13", "2026-10-13").await;
    let id: Uuid = c["id"].as_str().unwrap().parse().unwrap();
    let head = Uuid::new_v4();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO employment_heads(org_id,id,employee_id,valid_from,hire_date,severance_start_date) VALUES ($1,$2,$3,'2026-10-13T00:00:00+09:00','2024-01-01','2026-10-13')")
        .bind(w.org).bind(head).bind(w.in_a).execute(tx.as_mut()).await.unwrap();
    sqlx::query("UPDATE employee_exit_cases SET employment_id=$2 WHERE id=$1")
        .bind(id)
        .bind(head)
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET hire_date='2023-01-01',hire_on='2023-01-01' WHERE id=$1")
        .bind(w.in_a)
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let result = w.hr.draft_exit_approval(w.hr(w.hr_one), id,
        serde_json::from_value(json!({"submit":false,"settlement_input":{
            "average_wage_period_start":"2026-10-13","average_wage_period_end":"2026-10-13",
            "average_wage_calendar_days":0,"average_wage_total_won":0,"monthly_ordinary_wage_won":0
        }})).unwrap()).await.unwrap();
    let package = result.settlement_package.unwrap();
    assert_eq!(package.service_days, Some(1));
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE employment_heads SET severance_start_date=NULL WHERE id=$1")
        .bind(head)
        .execute(tx.as_mut())
        .await
        .unwrap();
    let context = console_hr_adapter_postgres::exits::store::load_exit_case_context(
        &mut tx, w.org, id, false,
    )
    .await
    .unwrap();
    assert_eq!(context.hire_date.as_deref(), Some("2024-01-01"));
    sqlx::query("UPDATE employment_heads SET hire_date=NULL WHERE id=$1")
        .bind(head)
        .execute(tx.as_mut())
        .await
        .unwrap();
    let context = console_hr_adapter_postgres::exits::store::load_exit_case_context(
        &mut tx, w.org, id, false,
    )
    .await
    .unwrap();
    assert_eq!(context.hire_date.as_deref(), Some("2023-01-01"));
    assert_eq!(package.severance_pay_won, Some(0));
    assert_eq!(
        package.statutory_basis["severance_eligibility"]["reason"],
        "UNDER_SERVICE_YEARS"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn historical_service_rule_covers_the_day_before_the_current_slice(pool: PgPool) {
    let gaps_or_overlaps: i64 = sqlx::query_scalar("SELECT count(*) FROM (SELECT day FROM generate_series(DATE '2005-12-01',DATE '2026-07-01',INTERVAL '1 day') day LEFT JOIN statutory_rules r ON r.code='SEVERANCE_MIN_SERVICE_YEARS' AND r.effective_from<=day AND (r.effective_to_exclusive IS NULL OR day<r.effective_to_exclusive) GROUP BY day HAVING count(r.code)<>1) invalid")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(gaps_or_overlaps, 0);
    let (w, c) = prepared(&pool, "2026-06-30", "2026-06-30").await;
    let p = &c["settlement_package"];
    assert_eq!(p["status"], "READY_FOR_APPROVAL");
    assert_eq!(p["severance_pay_won"], 0);
    assert_eq!(
        p["statutory_basis"]["calculation_references"]["rules"][0]["effective_from"],
        "2025-11-11"
    );
    let id = c["id"].as_str().unwrap().parse().unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE employee_exit_cases SET effective_exit_date='2005-11-30' WHERE id=$1")
        .bind(id)
        .execute(tx.as_mut())
        .await
        .unwrap();
    let error =
        console_hr_adapter_postgres::exits::settlement_store::upsert_exit_settlement_package(
            &mut tx,
            w.org,
            id,
            Some(serde_json::from_value(wage_input()).unwrap()),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "severance_statutory_basis_unavailable");
}
