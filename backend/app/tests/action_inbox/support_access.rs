// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn support_approvals_share_catalog_visibility_expiry_and_inbox_pagination(pool: PgPool) {
    let keys = keys();
    let branch = seed_branch(&pool, OrgId::one(), "지원 리전", "지원 지사").await;
    let approver = UserId::new();
    seed_user(&pool, OrgId::one(), approver, "MEMBER", branch).await;
    let grantor = UserId::new();
    seed_user(&pool, OrgId::one(), grantor, "MEMBER", branch).await;
    let role = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO access_roles(org_id,id,name_ko,status,version,created_by) VALUES($1,$2,'지원 접근 승인자','ACTIVE',1,$3)")
        .bind(OrgId::one().as_uuid()).bind(role).bind(approver.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions(org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES($1,$2,1,'지원 접근 승인자','ACTIVE','SETUP',$3)")
        .bind(OrgId::one().as_uuid()).bind(role).bind(approver.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines(org_id,role_id,version,domain,levels) VALUES($1,$2,1,'support_access',ARRAY['approve'])")
        .bind(OrgId::one().as_uuid()).bind(role).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_grants(org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES($1,$2,$3,'TENANT',now(),true,'SETUP','SUPPORT',$4)")
        .bind(OrgId::one().as_uuid()).bind(approver.as_uuid()).bind(role).bind(grantor.as_uuid()).execute(&pool).await.unwrap();
    let reader = UserId::new();
    seed_user(&pool, OrgId::one(), reader, "MEMBER", branch).await;
    let other_org = seed_org(&pool, "support-other", "다른 고객").await;
    let mut pending = BTreeSet::new();
    for (org, state, expired, tenant_approved) in [
        (OrgId::one(), "OPERATOR_APPROVED", false, false),
        (OrgId::one(), "OPERATOR_APPROVED", false, false),
        (OrgId::one(), "REQUESTED", false, false),
        (OrgId::one(), "OPERATOR_APPROVED", true, false),
        (OrgId::one(), "OPERATOR_APPROVED", false, true),
        (other_org, "OPERATOR_APPROVED", false, false),
    ] {
        let id = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO support_sessions(org_id,id,operator_ref,operator_label,ticket_ref,reason_code,reason,scope,requested_duration_seconds,state,requested_at,request_expires_at,request_assertion,operator_approver_ref,operator_approved_at,approval_assertion,tenant_approver_ref,tenant_approved_at) VALUES($1,$2,$3,'운영자 · 공급사','HELP-123','DIAGNOSE','조직 조회 오류 확인',ARRAY['org'],60,$4,now()-interval '1 minute',now()+CASE WHEN $5 THEN -interval '1 hour' ELSE interval '1 hour' END,gen_random_uuid(),CASE WHEN $4='REQUESTED' THEN NULL ELSE $6 END,CASE WHEN $4='REQUESTED' THEN NULL ELSE now() END,CASE WHEN $4='REQUESTED' THEN NULL ELSE gen_random_uuid() END,CASE WHEN $7 THEN $8 ELSE NULL END,CASE WHEN $7 THEN now() ELSE NULL END)")
            .bind(org.as_uuid()).bind(id).bind(uuid::Uuid::new_v4()).bind(state).bind(expired)
            .bind(uuid::Uuid::new_v4()).bind(tenant_approved).bind(approver.as_uuid())
            .execute(&pool).await.unwrap();
        if org == OrgId::one() && state == "OPERATOR_APPROVED" && !expired && !tenant_approved {
            pending.insert(format!("support_access:{id}"));
        }
    }
    let service =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());
    let token = bearer(&pool, &keys, OrgId::one(), approver, "MEMBER", branch).await;
    let mut path = format!("{PATH}?limit=1");
    let mut found = BTreeSet::new();
    loop {
        let response = get(service.clone(), &path, &token).await;
        assert_eq!(response.status, StatusCode::OK, "{:?}", response.json);
        for item in response.json["items"].as_array().unwrap() {
            if item["kind"] == "support_access" {
                assert_eq!(item["ref"], "HELP-123");
                assert_eq!(item["title"], "조직 조회 오류 확인");
                assert_eq!(item["links"][0]["kind"], "support_session");
                assert!(item["due"].is_string());
                assert!(found.insert(item["id"].as_str().unwrap().to_owned()));
            }
        }
        match response.json["next_cursor"].as_str() {
            Some(cursor) => path = format!("{PATH}?limit=1&cursor={cursor}"),
            None => break,
        }
    }
    assert_eq!(found, pending);
    for user in [reader, approver] {
        if user == approver {
            sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_by=$2,revoked_at=now() WHERE org_id=$1 AND role_id=$3")
                .bind(OrgId::one().as_uuid()).bind(user.as_uuid()).bind(role).execute(&pool).await.unwrap();
        }
        let response = get(
            service.clone(),
            PATH,
            &bearer(&pool, &keys, OrgId::one(), user, "MEMBER", branch).await,
        )
        .await;
        assert_eq!(response.status, StatusCode::OK, "{:?}", response.json);
        assert!(source_ids(&response.json, "support_access:").is_empty());
    }
}
