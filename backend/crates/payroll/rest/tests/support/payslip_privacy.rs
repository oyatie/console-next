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
