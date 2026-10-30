// SPDX-License-Identifier: LicenseRef-Proprietary
//! K1: repointing an account's employee link never makes another employee record "self".

use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn account_link_repoint_cannot_become_self_for_another_employee_record(pool: PgPool) {
    use console_hr_adapter_postgres::own_record::{OwnRecord, own_record_decision};
    use console_platform_authz::Feature;
    let keys = keys();
    let actor = UserId::new();
    let own_employee = seed_linked_employee(&pool, actor, "SUPER_ADMIN", "K1 actor").await;
    let victim_employee = seed_employee(&pool, "K1 unlinked victim").await;
    let linked_accounts: i64 =
        sqlx::query_scalar("SELECT count(*) FROM users WHERE employee_id = $1")
            .bind(victim_employee)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(linked_accounts, 0);
    let runtime = runtime_role_pool(&pool).await;
    let service = build_router(app_state(runtime.clone(), keys.public_pem.clone()).unwrap());
    let response = send(
        service,
        "PATCH",
        &format!("/api/v1/users/{actor}"),
        &bearer(&pool, &keys, actor, "SUPER_ADMIN").await,
        Some(json!({ "employee_id": victim_employee })),
    )
    .await;
    let (own, victim) = console_platform_db::with_org_conn::<
        _,
        _,
        console_hr_adapter_postgres::HrError,
    >(&runtime, OrgId::one(), |tx| {
        Box::pin(async move {
            Ok((
                own_record_decision(
                    tx,
                    OrgId::one(),
                    actor,
                    own_employee,
                    Feature::EmployeeDirectoryManage,
                )
                .await?,
                own_record_decision(
                    tx,
                    OrgId::one(),
                    actor,
                    victim_employee,
                    Feature::EmployeeDirectoryManage,
                )
                .await?,
            ))
        })
    })
    .await
    .unwrap();
    assert_eq!(
        victim,
        OwnRecord::NotOwn,
        "repointing must not make the victim self"
    );
    assert_eq!(own, OwnRecord::Refused);
    assert_eq!(
        response.status,
        StatusCode::PRECONDITION_REQUIRED,
        "{}",
        response.json
    );
    assert_eq!(response.json["error"]["code"], "step_up_required");
}

pub(super) async fn seed_employee(pool: &PgPool, name: &str) -> Uuid {
    let employee_id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO employees (
            id, org_id, company, name, employee_number, source_filename,
            source_sheet, source_row, source_key, raw_row, source_metadata
        )
        VALUES ($1, $2, '테스트', $3, NULL, 'employees.xlsx', '직원', 2, $4, '{}', '{}')
        "#,
    )
    .bind(employee_id)
    .bind(*OrgId::one().as_uuid())
    .bind(name)
    .bind(format!("employee-row-{name}"))
    .execute(pool)
    .await
    .unwrap();
    employee_id
}

/// Insert an employee and link `user_id` to it, so `GET /me` resolves a record.
pub(super) async fn seed_linked_employee(
    pool: &PgPool,
    user_id: UserId,
    role: &str,
    name: &str,
) -> Uuid {
    let employee_id = seed_employee(pool, name).await;
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, employee_id) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(*user_id.as_uuid())
    .bind(name)
    .bind(vec![role])
    .bind(*OrgId::one().as_uuid())
    .bind(employee_id)
    .execute(pool)
    .await
    .unwrap();
    employee_id
}
