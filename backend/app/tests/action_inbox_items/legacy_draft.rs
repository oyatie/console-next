// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{draft_access as a, draft_fixture as f, http};
use ::http::StatusCode;
use console_kernel_core::UserId;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

async fn member(t: &f::Tenant) -> UserId {
    let user = http::add_user(&t.owner, t.org, &["MEMBER"]).await;
    let role = Uuid::new_v4();
    sqlx::query("INSERT INTO policy_roles(org_id,id,role_key,display_name,status) VALUES($1,$2,'org_drafter','조직 기안자','ACTIVE')")
        .bind(t.org).bind(role).execute(&t.owner).await.unwrap();
    for feature in ["org_change_draft", "region_manage", "branch_manage"] {
        sqlx::query("INSERT INTO policy_role_permissions(org_id,role_id,feature_key,permission_level) VALUES($1,$2,$3,'allow')")
            .bind(t.org).bind(role).bind(feature).execute(&t.owner).await.unwrap();
    }
    sqlx::query("INSERT INTO user_role_assignments(org_id,user_id,role_id) VALUES($1,$2,$3)")
        .bind(t.org)
        .bind(user.as_uuid())
        .bind(role)
        .execute(&t.owner)
        .await
        .unwrap();
    user
}

async fn grant(t: &f::Tenant, user: UserId) {
    let role = Uuid::new_v4();
    sqlx::query("INSERT INTO access_roles(org_id,id,name_ko,status,version,created_by) VALUES($1,$2,'조직 초안','ACTIVE',1,$3)")
        .bind(t.org).bind(role).bind(t.actor).execute(&t.owner).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions(org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES($1,$2,1,'조직 초안','ACTIVE','SETUP',$3)")
        .bind(t.org).bind(role).bind(t.actor).execute(&t.owner).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines(org_id,role_id,version,domain,levels) VALUES($1,$2,1,'org',ARRAY['edit'])")
        .bind(t.org).bind(role).execute(&t.owner).await.unwrap();
    sqlx::query("INSERT INTO access_grants(org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES($1,$2,$3,'TENANT',now()-interval '1 day',true,'SETUP','TEST',$4)")
        .bind(t.org).bind(user.as_uuid()).bind(role).bind(t.actor).execute(&t.owner).await.unwrap();
}

async fn live_rows(t: &f::Tenant) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM regions r WHERE org_id=$1),(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM branches b WHERE org_id=$1))")
        .bind(t.org).fetch_one(&t.owner).await.unwrap()
}

async fn posts(t: &f::Tenant, user: UserId, admitted: bool) {
    let region: Uuid =
        sqlx::query_scalar("INSERT INTO regions(org_id,name) VALUES($1,$2) RETURNING id")
            .bind(t.org)
            .bind(Uuid::new_v4().to_string())
            .fetch_one(&t.owner)
            .await
            .unwrap();
    let ctx = http::ctx(&t.owner, t.org, user, &["MEMBER"], None).await;
    let live = live_rows(t).await;
    for (path, body) in [
        ("/api/v1/regions", json!({"name":"신설 지역"})),
        (
            "/api/v1/branches",
            json!({"name":"신설 지점","region_id":region}),
        ),
    ] {
        let before = a::snapshot(t).await;
        let (status, body) = ctx.call("POST", path, Some(body)).await;
        if admitted {
            // Admission succeeds; these retired creation verbs still fail domain validation.
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{path}: {body}");
            assert_eq!(body["error"]["code"], "region_branch_retired");
        } else {
            assert_eq!(status, StatusCode::FORBIDDEN, "{path}: {body}");
            assert_eq!(body["error"]["code"], "org_change.refuse.missing_grant");
            assert!(
                body["error"]["support_ref"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty())
            );
            assert_eq!(a::snapshot(t).await, before);
            let mut invalid = json!({"name":"가".repeat(121),"region_id":region});
            if path.ends_with("regions") {
                invalid.as_object_mut().unwrap().remove("region_id");
            }
            let (status, body) = ctx.call("POST", path, Some(invalid)).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{path}: {body}");
            assert_eq!(body["error"]["code"], "org_change.refuse.missing_grant");
            assert_eq!(a::snapshot(t).await, before);
        }
        assert_eq!(a::snapshot(t).await, before);
        assert_eq!(live_rows(t).await, live);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_org_edit_member_can_post_regions_and_branches_until_grant_revoked(pool: PgPool) {
    let t = f::tenant(pool).await;
    let user = member(&t).await;
    grant(&t, user).await;
    posts(&t, user, true).await;
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE org_id=$1 AND account_id=$2")
        .bind(t.org).bind(user.as_uuid()).execute(&t.owner).await.unwrap();
    posts(&t, user, false).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn member_without_tenant_org_edit_gets_exact_403_until_granted(pool: PgPool) {
    let t = f::tenant(pool).await;
    let user = member(&t).await;
    posts(&t, user, false).await;
    grant(&t, user).await;
    posts(&t, user, true).await;
}
