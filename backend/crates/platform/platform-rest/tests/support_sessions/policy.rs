// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_policy_tightens_request_deadline_and_duration_but_cannot_exceed_registry(
    owner: PgPool,
) {
    let mut h = Support::new(owner).await;
    let default_hours = |key: SettingKey| match key.def().default {
        Some(SettingValue::Int(value)) => value,
        _ => panic!("support policy must be registered"),
    };
    let max_hours = default_hours(SettingKey::SupportMaxDuration) - 1;
    let expiry_hours = default_hours(SettingKey::SupportRequestExpiry) - 1;
    for (key, hours) in [
        (SettingKey::SupportMaxDuration, max_hours),
        (SettingKey::SupportRequestExpiry, expiry_hours),
    ] {
        sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,effective_from,set_by,reason_code,direction) SELECT org_id,$2,$3,now(),id,'SUPPORT_POLICY','tighten' FROM users WHERE org_id=$1 AND is_tenant_ops")
            .bind(h.org).bind(key.as_str()).bind(json!(hours)).execute(&h.owner).await.unwrap();
        let err = sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,effective_from,set_by,reason_code,direction) SELECT org_id,$2,$3,now(),id,'SUPPORT_POLICY','loosen' FROM users WHERE org_id=$1 AND is_tenant_ops")
            .bind(h.org).bind(key.as_str()).bind(json!(default_hours(key)+1)).execute(&h.owner).await.unwrap_err();
        assert_eq!(
            err.as_database_error().unwrap().code().as_deref(),
            Some("23514")
        );
    }
    let id = Uuid::new_v4();
    let mut body = h.body(id);
    body["duration_seconds"] = json!(default_hours(SettingKey::SupportMaxDuration) * 3600);
    ok(
        h.signed(false, id, "request", body).await,
        StatusCode::CREATED,
    );
    let row: (i64, f64) = sqlx::query_as("SELECT requested_duration_seconds,extract(epoch FROM request_expires_at-requested_at)::float8 FROM support_sessions WHERE id=$1")
        .bind(id).fetch_one(&h.owner).await.unwrap();
    assert_eq!(row, (max_hours * 3600, (expiry_hours * 3600) as f64));
    ok(h.approve(id).await, StatusCode::OK);
    code(h.send("POST", &format!("{TENANT}/{id}/decision"), json!({"decision":"APPROVE","approved_duration_seconds":max_hours*3600+1,"reveal_classes":[]}), &h.tenant).await,
        StatusCode::UNPROCESSABLE_ENTITY,"validation");
    ok(h.send("POST", &format!("{TENANT}/{id}/decision"), json!({"decision":"APPROVE","approved_duration_seconds":max_hours*3600,"reveal_classes":[]}), &h.tenant).await,StatusCode::OK);
    ok(h.start(id).await, StatusCode::OK);
    let seconds: f64 = sqlx::query_scalar("SELECT extract(epoch FROM expires_at-started_at)::float8 FROM support_sessions WHERE id=$1")
        .bind(id).fetch_one(&h.owner).await.unwrap();
    assert_eq!(seconds, (max_hours * 3600) as f64);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn approval_holder_is_found_among_two_thousand_accounts_without_per_user_loading(
    owner: PgPool,
) {
    let mut h = Support::new(owner).await;
    h.org = Uuid::new_v4();
    console_platform_test_support::seed_org_rls_off(&h.owner, h.org, "support-capacity").await;
    sqlx::query("INSERT INTO users(id,org_id,display_name,roles) SELECT gen_random_uuid(),$1,'Capacity account '||n,ARRAY[]::text[] FROM generate_series(1,2000) n")
        .bind(h.org).execute(&h.owner).await.unwrap();
    let users: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE org_id=$1 ORDER BY id")
        .bind(h.org)
        .fetch_all(&h.owner)
        .await
        .unwrap();
    let (grantor, approver) = (users[0], users[1999]);
    let role = Uuid::new_v4();
    sqlx::query("INSERT INTO access_roles(org_id,id,name_ko,status,version,created_by) VALUES($1,$2,'지원 접근 승인자','ACTIVE',1,$3)")
        .bind(h.org).bind(role).bind(grantor).execute(&h.owner).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions(org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES($1,$2,1,'지원 접근 승인자','ACTIVE','SETUP',$3)")
        .bind(h.org).bind(role).bind(grantor).execute(&h.owner).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines(org_id,role_id,version,domain,levels) VALUES($1,$2,1,'support_access',ARRAY['approve'])")
        .bind(h.org).bind(role).execute(&h.owner).await.unwrap();
    sqlx::query("INSERT INTO access_grants(org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES($1,$2,$3,'TENANT',now(),true,'SETUP','SUPPORT',$4)")
        .bind(h.org).bind(approver).bind(role).bind(grantor).execute(&h.owner).await.unwrap();
    ok(h.request(Uuid::new_v4()).await, StatusCode::CREATED);
    sqlx::query(
        "UPDATE access_grants SET status='REVOKED',revoked_by=$2,revoked_at=now() WHERE org_id=$1",
    )
    .bind(h.org)
    .bind(grantor)
    .execute(&h.owner)
    .await
    .unwrap();
    code(
        h.request(Uuid::new_v4()).await,
        StatusCode::CONFLICT,
        "support.refuse.no_tenant_approver",
    );
}
