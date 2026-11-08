// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn weekly_totals_rest_contract_is_nullable_tenant_isolated_and_cedar_scoped(pool: PgPool) {
    let admin = UserId::new();
    let employee = seed_linked_employee(&pool, admin, "SUPER_ADMIN", "weekly-contract").await;
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(admin.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let foreign_org = Uuid::new_v4();
    console_platform_test_support::seed_org_and_super_admin(&pool, foreign_org, "weekly foreign")
        .await;
    let foreign_employee = Uuid::new_v4();
    sqlx::query("INSERT INTO employees(id,org_id,company,name,source_filename,source_sheet,source_row,source_key,employment_status) VALUES($1,$2,'foreign','Foreign weekly employee','console','console',1,$1::text,'ACTIVE')")
        .bind(foreign_employee).bind(foreign_org).execute(&pool).await.unwrap();
    let keys = keys();
    let router =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());
    let token = bearer(&pool, &keys, admin, "SUPER_ADMIN").await;
    let path = "/api/v1/attendance/week52?week_start=2026-10-26";
    let response = get(router.clone(), path, &token).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.json);
    let rows = response.json["items"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    let name: String = sqlx::query_scalar("SELECT name FROM employees WHERE id=$1")
        .bind(employee)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        rows[0],
        json!({
            "employee_id": employee, "name": name, "week_start": "2026-10-26",
            "current_hours": 0.0, "projected_hours": 0.0, "recognized_hours": null,
            "overtime_hours": null, "tone": "OK", "acked": false
        })
    );
    assert!(
        !response
            .json
            .to_string()
            .contains(&foreign_employee.to_string())
    );
    // Old role labels cannot substitute for the live Cedar grant snapshot.
    let denied = UserId::new();
    seed_user(&pool, denied, "SUPER_ADMIN").await;
    let branch =
        console_platform_test_support::seed_branch(&pool, "weekly contract", "operations").await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("DELETE FROM access_grants WHERE account_id=$1")
        .bind(denied.as_uuid())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET is_tenant_ops=false WHERE id=$1")
        .bind(denied.as_uuid())
        .execute(&mut *tx)
        .await
        .unwrap();
    let role = Uuid::new_v4();
    let org = *OrgId::one().as_uuid();
    sqlx::query("INSERT INTO access_roles(org_id,id,name_ko,status,version,created_by) VALUES($1,$2,'근태 처리','ACTIVE',1,$3)").bind(org).bind(role).bind(admin.as_uuid()).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions(org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES($1,$2,1,'근태 처리','ACTIVE','SETUP',$3)").bind(org).bind(role).bind(admin.as_uuid()).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines(org_id,role_id,version,domain,levels) VALUES($1,$2,1,'attendance',ARRAY['edit'])").bind(org).bind(role).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO access_grants(org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES($1,$2,$3,'TENANT','2026-01-01',true,'SETUP','TEST',$4)").bind(org).bind(denied.as_uuid()).bind(role).bind(admin.as_uuid()).execute(&mut *tx).await.unwrap();
    sqlx::query("UPDATE employees SET home_branch_id=$1 WHERE id=$2")
        .bind(branch.as_uuid())
        .bind(employee)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO user_branches(org_id,user_id,branch_id) VALUES($1,$2,$3)")
        .bind(org)
        .bind(denied.as_uuid())
        .bind(branch.as_uuid())
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let refused = get(
        router.clone(),
        path,
        &bearer(&pool, &keys, denied, "SUPER_ADMIN").await,
    )
    .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.json);
    assert_eq!(refused.json["error"]["code"], "forbidden");
    assert!(refused.json.get("items").is_none());
    let denied_token = bearer(&pool, &keys, denied, "SUPER_ADMIN").await;
    let refused_ack = post(
        router,
        "/api/v1/attendance/week52/acks",
        &denied_token,
        json!({"employee_id": employee, "week_start": "2026-10-26"}),
    )
    .await;
    assert_eq!(
        refused_ack.status,
        StatusCode::FORBIDDEN,
        "{}",
        refused_ack.json
    );
    let acknowledgements: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM attendance_week52_acknowledgements WHERE employee_id=$1",
    )
    .bind(employee)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        acknowledgements, 0,
        "a read refusal must not acknowledge the week"
    );
}
