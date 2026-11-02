// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn module_facts_refuse_owner_unarmed_and_wrong_tenant_transactions(pool: PgPool) {
    use console_platform_authz::cedar_pbac::visible::PayrollModuleFactLoader;
    let org = OrgId::new();
    seed_org_and_super_admin(&pool, *org.as_uuid(), "module RLS").await;
    let runtime = runtime_role_pool(&pool).await;
    let store = PgPayrollStore::new(runtime.clone());
    for (connection, allowed) in [(&pool, false), (&runtime, true)] {
        let mut tx = connection.begin().await.unwrap();
        assert!(store.payroll_enabled(&mut tx, org).await.is_err());
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        assert!(store.payroll_enabled(&mut tx, OrgId::new()).await.is_err());
        let decision = store.payroll_enabled(&mut tx, org).await;
        if allowed {
            assert!(decision.unwrap());
        } else {
            assert!(decision.is_err());
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn disabled_module_refuses_every_payroll_route_and_recovers_per_tenant(pool: PgPool) {
    let org = OrgId::new();
    let actor = seed_org_and_super_admin(&pool, *org.as_uuid(), "payroll module").await;
    let keys = keys();
    let token = bearer(&pool, &keys, actor, org, "SUPER_ADMIN").await;
    let runtime = runtime_role_pool(&pool).await;
    let service = app(runtime.clone(), &keys);
    // The default must work before any activation row exists.
    assert_eq!(
        get(service.clone(), PAYROLL_MY_PAYSLIPS_PATH, &token)
            .await
            .status,
        StatusCode::OK
    );
    for enabled in [false, true, false] {
        // rls-arming: ok fixture changes only this tenant's effective-dated module setting.
        let effective: OffsetDateTime = sqlx::query_scalar("INSERT INTO tenant_setting_overrides(org_id,key,value,effective_from,set_by,reason_code) VALUES ($1,'module.payroll.enabled',$2,clock_timestamp(),$3,'POLICY_REVIEW') RETURNING effective_from")
            .bind(org.as_uuid()).bind(json!(enabled)).bind(actor.as_uuid()).fetch_one(&pool).await.unwrap();
        if let Ok(wait) = (effective - OffsetDateTime::now_utc()).try_into() {
            tokio::time::sleep(wait).await;
        }
        for path in console_payroll_rest::PAYROLL_ROUTE_PATHS {
            let path = path
                .replace("{id}", &Uuid::new_v4().to_string())
                .replace("{employee_id}", &Uuid::new_v4().to_string())
                .replace("{exception_id}", &Uuid::new_v4().to_string());
            for method in ["GET", "POST", "PUT"] {
                let response = service
                    .clone()
                    .oneshot(
                        Request::builder()
                            .method(method)
                            .uri(&path)
                            .header(header::AUTHORIZATION, format!("Bearer {token}"))
                            .header(header::CONTENT_TYPE, "application/json")
                            .body(Body::from("{}"))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                let status = response.status();
                if status == StatusCode::METHOD_NOT_ALLOWED {
                    continue;
                }
                let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
                let body: Value = serde_json::from_slice(&bytes)
                    .unwrap_or_else(|_| json!({"body": String::from_utf8_lossy(&bytes)}));
                if enabled {
                    assert_ne!(
                        body["error"]["code"], "module_disabled",
                        "{method} {path}: {body}"
                    );
                } else {
                    assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}: {body}");
                    assert_eq!(
                        body["error"]["code"], "module_disabled",
                        "{method} {path}: {body}"
                    );
                }
            }
        }
    }
    let other = OrgId::new();
    let other_actor =
        seed_org_and_super_admin(&pool, *other.as_uuid(), "other payroll tenant").await;
    let other_token = bearer(&pool, &keys, other_actor, other, "SUPER_ADMIN").await;
    assert_eq!(
        get(service, PAYROLL_MY_PAYSLIPS_PATH, &other_token)
            .await
            .status,
        StatusCode::OK
    );
}
