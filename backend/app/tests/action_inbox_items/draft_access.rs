// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{draft_fixture as f, http, org_change};
use ::http::StatusCode;
use console_kernel_core::UserId;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

fn draft(unit: Uuid) -> Value {
    json!({"kind":"REORG", "target":{"kind":"ORG_UNIT","ref":unit,"label":"부서"},
        "effectiveDate":f::day(7),"reason":"조직 개편",
        "proposal":[{"op":"RENAME_ORG_UNIT","orgUnitId":unit,"name":"개편 부서"}]})
}

fn normalized(mut body: Value) -> Value {
    for key in ["support_ref", "support_ref_at", "trace_id", "operation_id"] {
        body["error"].as_object_mut().unwrap().remove(key);
    }
    body
}

async fn snapshot(t: &f::Tenant) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM org_change_requests r WHERE org_id=$1),(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM org_change_approval_steps s WHERE org_id=$1),(SELECT count(*) FROM org_change_events WHERE org_id=$1),(SELECT count(*) FROM audit_events WHERE org_id=$1 AND action LIKE 'org_change.%' AND outcome='ALLOWED'))")
        .bind(t.org).fetch_one(&t.owner).await.unwrap()
}

async fn grant(t: &f::Tenant, user: UserId) {
    let role = Uuid::new_v4();
    sqlx::query("INSERT INTO access_roles(org_id,id,name_ko,status,version,created_by) VALUES($1,$2,'조직 초안','ACTIVE',1,$3)")
        .bind(t.org).bind(role).bind(t.actor).execute(&t.owner).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions(org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES($1,$2,1,'조직 초안','ACTIVE','SETUP',$3)")
        .bind(t.org).bind(role).bind(t.actor).execute(&t.owner).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines(org_id,role_id,version,domain,levels) VALUES($1,$2,1,'org',ARRAY['edit'])")
        .bind(t.org).bind(role).execute(&t.owner).await.unwrap();
    sqlx::query("INSERT INTO access_grants(org_id,account_id,role_id,scope_kind,legal_entity_id,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES($1,$2,$3,'LEGAL_ENTITY',$4,now()-interval '1 day',true,'SETUP','TEST',$5)")
        .bind(t.org).bind(user.as_uuid()).bind(role).bind(t.entity).bind(t.actor).execute(&t.owner).await.unwrap();
}

async fn lifecycle(t: &f::Tenant, user: UserId, role: &str, unit: Uuid) {
    let ctx = http::ctx(&t.owner, t.org, user, &[role], None).await;
    let (status, created) = ctx.call("POST", f::CHANGES, Some(draft(unit))).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let path = format!("{}/{}", f::CHANGES, created["id"].as_str().unwrap());
    for (method, suffix, body) in [
        ("PATCH", "", Some(json!({"reason":"초안 수정"}))),
        ("POST", "/preflight", None),
        ("POST", "/cancel", Some(json!({"reason":"초안 취소"}))),
    ] {
        let (status, body) = ctx.call(method, &format!("{path}{suffix}"), body).await;
        assert_eq!(status, StatusCode::OK, "{suffix}: {body}");
    }
    let (status, created) = ctx.call("POST", f::CHANGES, Some(draft(unit))).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let path = format!("{}/{}", f::CHANGES, created["id"].as_str().unwrap());
    let (status, submitted) = ctx.call("POST", &format!("{path}/submit"), None).await;
    assert_eq!(status, StatusCode::OK, "{submitted}");
    assert_eq!(submitted["status"], "IN_APPROVAL");
    let (status, cancelled) = ctx
        .call(
            "POST",
            &format!("{path}/cancel"),
            Some(json!({"reason":"상신 회수"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{cancelled}");
    assert_eq!(cancelled["approvalSteps"], submitted["approvalSteps"]);
}

async fn refused(t: &f::Tenant, ctx: &http::Ctx, unit: Uuid) {
    let id = t
        .draft("REORG", unit, draft(unit)["proposal"].clone(), &f::day(7))
        .await;
    let before = snapshot(t).await;
    let (status, body) = ctx.call("POST", f::CHANGES, Some(draft(unit))).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "org_change.refuse.missing_grant");
    assert_eq!(snapshot(t).await, before);
    let expected = normalized(body);
    for state in ["DRAFT", "APPROVED", "IN_APPROVAL"] {
        sqlx::query("UPDATE org_change_requests SET status=$2 WHERE id=$1")
            .bind(Uuid::parse_str(&id).unwrap())
            .bind(state)
            .execute(&t.owner)
            .await
            .unwrap();
        let before_state = snapshot(t).await;
        for target in [id.clone(), Uuid::new_v4().to_string()] {
            for (method, suffix, payload) in [
                ("PATCH", "", Some(json!({"reason":"권한 없는 수정"}))),
                ("POST", "/preflight", None),
                ("POST", "/submit", None),
                ("POST", "/cancel", Some(json!({"reason":"권한 없는 취소"}))),
            ] {
                let (status, body) = ctx
                    .call(method, &format!("{}/{target}{suffix}", f::CHANGES), payload)
                    .await;
                assert_eq!(status, StatusCode::NOT_FOUND, "{state} {suffix}: {body}");
                assert!(
                    body["error"]["support_ref"]
                        .as_str()
                        .is_some_and(|s| !s.is_empty())
                );
                assert_eq!(
                    normalized(body),
                    expected,
                    "same refusal for missing, foreign and inaccessible documents"
                );
                assert_eq!(snapshot(t).await, before_state);
            }
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_role_can_complete_the_draft_lifecycle_without_an_ops_flag(pool: PgPool) {
    let t = f::tenant(pool).await;
    t.route_org_changes().await;
    let is_ops: bool = sqlx::query_scalar("SELECT is_tenant_ops FROM users WHERE id=$1")
        .bind(t.actor)
        .fetch_one(&t.owner)
        .await
        .unwrap();
    assert!(
        !is_ops,
        "the regression fixture must remain a legacy-role-only account"
    );
    let unit = t.dept("기존 부서", t.sites[0]).await;
    lifecycle(&t, UserId::from_uuid(t.actor), "SUPER_ADMIN", unit).await;
    let ctx = http::ctx(
        &t.owner,
        t.org,
        UserId::from_uuid(t.actor),
        &["SUPER_ADMIN"],
        None,
    )
    .await;
    let (foreign_org, maker) = http::tenant(&t.owner, &["MEMBER"]).await;
    let (id, _) = org_change::request(&t.owner, foreign_org, maker).await;
    let before = org_change::snapshot(&t.owner, id).await;
    for (method, suffix, body) in [
        ("PATCH", "", Some(json!({"reason":"다른 회사 수정"}))),
        ("POST", "/preflight", None),
        ("POST", "/submit", None),
        ("POST", "/cancel", Some(json!({"reason":"다른 회사 회수"}))),
    ] {
        let (status, body) = ctx
            .call(method, &format!("{}/{id}{suffix}", f::CHANGES), body)
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["error"]["code"], "org_change.refuse.missing_grant");
        assert_eq!(org_change::snapshot(&t.owner, id).await, before);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_role_removed_in_the_database_loses_draft_authority(pool: PgPool) {
    let t = f::tenant(pool).await;
    t.route_org_changes().await;
    let user = http::add_user(&t.owner, t.org, &["ADMIN"]).await;
    sqlx::query("UPDATE users SET roles=ARRAY['MEMBER'] WHERE id=$1")
        .bind(user.as_uuid())
        .execute(&t.owner)
        .await
        .unwrap();
    let ctx = http::ctx(&t.owner, t.org, user, &["MEMBER"], None).await;
    refused(&t, &ctx, t.sites[0]).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn subtenant_draft_grant_can_complete_the_same_lifecycle_in_scope(pool: PgPool) {
    let t = f::tenant(pool).await;
    t.route_org_changes().await;
    let user = http::add_user(&t.owner, t.org, &["MEMBER"]).await;
    grant(&t, user).await;
    let unit = t.dept("기존 부서", t.sites[0]).await;
    lifecycle(&t, user, "MEMBER", unit).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn subtenant_draft_grant_cannot_mutate_outside_its_scope(pool: PgPool) {
    let t = f::tenant(pool).await;
    t.route_org_changes().await;
    let user = http::add_user(&t.owner, t.org, &["MEMBER"]).await;
    grant(&t, user).await;
    let ctx = http::ctx(&t.owner, t.org, user, &["MEMBER"], None).await;
    refused(&t, &ctx, t.other_entity_site().await).await;
    let (foreign_org, foreign) = http::tenant(&t.owner, &["SUPER_ADMIN"]).await;
    let foreign = http::ctx(&t.owner, foreign_org, foreign, &["SUPER_ADMIN"], None).await;
    let id = t
        .draft(
            "REORG",
            t.sites[0],
            draft(t.sites[0])["proposal"].clone(),
            &f::day(7),
        )
        .await;
    for suffix in ["", "/preflight", "/submit", "/cancel"] {
        let (status, _) = foreign
            .call(
                if suffix.is_empty() { "PATCH" } else { "POST" },
                &format!("{}/{id}{suffix}", f::CHANGES),
                Some(json!({"reason":"다른 회사"})),
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn no_grant_member_gets_the_same_404_before_state_and_scheduled_locks(pool: PgPool) {
    let t = f::tenant(pool).await;
    t.route_org_changes().await;
    let user = http::add_user(&t.owner, t.org, &["MEMBER"]).await;
    let ctx = http::ctx(&t.owner, t.org, user, &["MEMBER"], None).await;
    refused(&t, &ctx, t.sites[0]).await;
}
