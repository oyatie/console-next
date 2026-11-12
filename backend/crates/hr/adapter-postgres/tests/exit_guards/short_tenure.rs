// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
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
    sqlx::query("UPDATE statutory_rules SET effective_to_exclusive=DATE '2026-10-14' WHERE code='SEVERANCE_MIN_SERVICE_YEARS'")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO statutory_rules SELECT (jsonb_populate_record(NULL::statutory_rules,to_jsonb(r)||jsonb_build_object('effective_from','2026-10-14','effective_to_exclusive',NULL,'value_num',3))).* FROM statutory_rules r WHERE code='SEVERANCE_MIN_SERVICE_YEARS'")
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

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn missing_service_rule_keeps_settlement_unpayable(pool: PgPool) {
    sqlx::query("UPDATE statutory_rules SET effective_to_exclusive=DATE '2026-10-13' WHERE code='SEVERANCE_MIN_SERVICE_YEARS'")
        .execute(&pool).await.unwrap();
    let (w, c) = prepared(&pool, "2026-10-13", "2026-10-13").await;
    assert!(c["settlement_package"]["severance_pay_won"].is_null());
    assert!(
        c["settlement_package"]["missing_source_fields"]
            .as_array()
            .unwrap()
            .contains(&json!("statutory_rules"))
    );
    let id = c["id"].as_str().unwrap().parse().unwrap();
    let error =
        w.hr.draft_exit_approval(
            w.hr(w.hr_one),
            id,
            serde_json::from_value(json!({"submit":true})).unwrap(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "validation");
    let status: String =
        sqlx::query_scalar("SELECT status FROM employee_exit_cases WHERE org_id=$1 AND id=$2")
            .bind(w.org)
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "HQ_CONFIRMED");
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
    sqlx::query("INSERT INTO employment_heads(org_id,id,employee_id,valid_from,hire_date,severance_start_date) VALUES ($1,$2,$3,'2026-10-13T00:00:00+09:00','2026-10-13','2026-10-13')")
        .bind(w.org).bind(head).bind(w.in_a).execute(tx.as_mut()).await.unwrap();
    sqlx::query("UPDATE employee_exit_cases SET employment_id=$2 WHERE id=$1")
        .bind(id)
        .bind(head)
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET hire_date='2024-01-01',hire_on='2024-01-01' WHERE id=$1")
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
    assert_eq!(package.severance_pay_won, Some(0));
    assert_eq!(
        package.statutory_basis["severance_eligibility"]["reason"],
        "UNDER_SERVICE_YEARS"
    );
}
