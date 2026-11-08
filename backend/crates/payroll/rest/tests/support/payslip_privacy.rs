// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

async fn fixture(owner: &PgPool) -> (PgPool, Keys, OrgId, UserId, Uuid) {
    let org = OrgId::one();
    seed_org(owner, *org.as_uuid()).await;
    let employee = seed_employee(owner, *org.as_uuid(), "김근로").await;
    let actor = UserId::new();
    seed_user(owner, actor, *org.as_uuid(), "MEMBER").await;
    pay_view::grant_view(owner, org, actor, None).await;
    (runtime_role_pool(owner).await, keys(), org, actor, employee)
}

fn contract() -> Value {
    json!({"effective_from":"2026-07-01","wage_kind":"MONTHLY",
        "amount_won":3_000_000,"monthly_standard_hours":209})
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pay_view_cannot_read_individual_draft_but_manage_can(owner: PgPool) {
    let (rt, keys, org, actor, employee) = fixture(&owner).await;
    let token = bearer(&owner, &keys, actor, org, "MEMBER").await;
    for target in [employee, Uuid::new_v4()] {
        let denied = get(
            app(rt.clone(), &keys),
            &format!("/api/v1/payroll/employees/{target}/payslip-draft?period=2026-07"),
            &token,
        )
        .await;
        assert_eq!(denied.status, StatusCode::FORBIDDEN, "{}", denied.json);
        assert_eq!(denied.json["error"]["code"], "forbidden");
        assert_no_compensation_payload(&denied.json, "김근로");
    }
    pay_view::grant_manage(&owner, org, actor, None).await;
    let created = post(
        app(rt.clone(), &keys),
        &format!("/api/v1/payroll/employees/{employee}/contract-wages"),
        &token,
        contract(),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.json);
    let draft = get(
        app(rt, &keys),
        &format!("/api/v1/payroll/employees/{employee}/payslip-draft?period=2026-07"),
        &token,
    )
    .await;
    assert_eq!(draft.status, StatusCode::OK, "{}", draft.json);
    assert_eq!(draft.json["contract"]["amount_won"], 3_000_000);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pay_view_cannot_write_contract_wages_but_manage_can(owner: PgPool) {
    let (rt, keys, org, actor, employee) = fixture(&owner).await;
    let token = bearer(&owner, &keys, actor, org, "MEMBER").await;
    for target in [employee, Uuid::new_v4()] {
        let denied = post(
            app(rt.clone(), &keys),
            &format!("/api/v1/payroll/employees/{target}/contract-wages"),
            &token,
            contract(),
        )
        .await;
        assert_eq!(denied.status, StatusCode::FORBIDDEN, "{}", denied.json);
        assert_eq!(denied.json["error"]["code"], "forbidden");
        assert_no_compensation_payload(&denied.json, "김근로");
    }
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM employee_contract_wages WHERE employee_id=$1")
            .bind(employee)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(count, 0, "denied writes cannot persist a contract");
    pay_view::grant_manage(&owner, org, actor, None).await;
    let created = post(
        app(rt, &keys),
        &format!("/api/v1/payroll/employees/{employee}/contract-wages"),
        &token,
        contract(),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.json);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn duplicate_contract_wage_is_typed_conflict_without_wage_or_audit_changes(owner: PgPool) {
    let (rt, keys, org, actor, employee) = fixture(&owner).await;
    pay_view::grant_manage(&owner, org, actor, None).await;
    let token = bearer(&owner, &keys, actor, org, "MEMBER").await;
    let uri = format!("/api/v1/payroll/employees/{employee}/contract-wages");
    let created = post(app(rt.clone(), &keys), &uri, &token, contract()).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.json);
    let wages_sql = "SELECT to_jsonb(w) FROM employee_contract_wages w WHERE org_id=$1 ORDER BY id";
    let audits_sql = "SELECT to_jsonb(a) FROM audit_events a WHERE org_id=$1 AND action='payroll_contract_wage.create' ORDER BY id";
    let wages: Vec<Value> = sqlx::query_scalar(wages_sql)
        .bind(org.as_uuid())
        .fetch_all(&owner)
        .await
        .unwrap();
    let audits: Vec<Value> = sqlx::query_scalar(audits_sql)
        .bind(org.as_uuid())
        .fetch_all(&owner)
        .await
        .unwrap();
    assert_eq!(wages.len(), 1);
    assert_eq!(audits.len(), 1);
    assert_eq!(audits[0]["target_id"], created.json["id"]);
    for body in [
        contract(),
        json!({"effective_from":"2026-07-01","wage_kind":"HOURLY",
        "amount_won":20_000,"monthly_standard_hours":200,"source_note":"변경한 합성 계약"}),
    ] {
        let refused = post(app(rt.clone(), &keys), &uri, &token, body).await;
        assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.json);
        assert_eq!(refused.json["error"]["code"], "contract_wage_exists");
        let after_wages: Vec<Value> = sqlx::query_scalar(wages_sql)
            .bind(org.as_uuid())
            .fetch_all(&owner)
            .await
            .unwrap();
        let after_audits: Vec<Value> = sqlx::query_scalar(audits_sql)
            .bind(org.as_uuid())
            .fetch_all(&owner)
            .await
            .unwrap();
        assert_eq!(after_wages, wages);
        assert_eq!(after_audits, audits);
    }
    let mut later = contract();
    later["effective_from"] = json!("2026-08-01");
    let corrected = post(app(rt.clone(), &keys), &uri, &token, later).await;
    assert_eq!(corrected.status, StatusCode::CREATED, "{}", corrected.json);
    assert_ne!(corrected.json["id"], created.json["id"]);

    let mut concurrent = contract();
    concurrent["effective_from"] = json!("2026-09-01");
    let (first, second) = tokio::join!(
        post(app(rt.clone(), &keys), &uri, &token, concurrent.clone()),
        post(app(rt.clone(), &keys), &uri, &token, concurrent),
    );
    let (created, refused) = if first.status == StatusCode::CREATED {
        (first, second)
    } else {
        (second, first)
    };
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.json);
    assert_eq!(refused.status, StatusCode::CONFLICT, "{}", refused.json);
    assert_eq!(refused.json["error"]["code"], "contract_wage_exists");

    sqlx::query("UPDATE employees SET employment_status='EXITED',exit_date='2026-10-10' WHERE org_id=$1 AND id=$2")
        .bind(org.as_uuid()).bind(employee).execute(&owner).await.unwrap();
    let exited = post(app(rt, &keys), &uri, &token, contract()).await;
    assert_eq!(exited.status, StatusCode::CONFLICT, "{}", exited.json);
    assert_eq!(exited.json["error"]["code"], "employee_exited_read_only");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='payroll_contract_wage.create'")
        .bind(org.as_uuid()).fetch_one(&owner).await.unwrap();
    assert_eq!(count, 3);
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM employee_contract_wages WHERE org_id=$1")
            .bind(org.as_uuid())
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(count, 3);
}
