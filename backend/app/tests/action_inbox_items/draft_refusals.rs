// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{draft_access as a, draft_fixture as f, http};
use ::http::StatusCode;
use console_kernel_core::UserId;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

fn refusal(body: &Value, code: &str) {
    assert_eq!(body["error"]["code"], code);
    assert!(
        body["error"]["support_ref"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn malformed_target_is_validation_without_writing_a_draft(pool: PgPool) {
    let t = f::tenant(pool).await;
    let ctx = http::ctx(
        &t.owner,
        t.org,
        UserId::from_uuid(t.actor),
        &["SUPER_ADMIN"],
        None,
    )
    .await;
    let mut body = a::draft(t.sites[0]);
    body["target"]["ref"] = json!("not-a-uuid");
    let before = a::snapshot(&t).await;
    let (status, body) = ctx.call("POST", f::CHANGES, Some(body)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    refusal(&body, "validation");
    assert_eq!(a::snapshot(&t).await, before);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn create_without_target_authority_is_forbidden_without_writing(pool: PgPool) {
    let t = f::tenant(pool).await;
    let user = http::add_user(&t.owner, t.org, &["MEMBER"]).await;
    a::grant(&t, user).await;
    let ctx = http::ctx(&t.owner, t.org, user, &["MEMBER"], None).await;
    let foreign = f::tenant(t.owner.clone()).await;
    for target in [
        t.other_entity_site().await,
        foreign.sites[0],
        Uuid::new_v4(),
    ] {
        let before = a::snapshot(&t).await;
        let (status, body) = ctx.call("POST", f::CHANGES, Some(a::draft(target))).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        refusal(&body, "org_change.refuse.missing_grant");
        assert_eq!(a::snapshot(&t).await, before);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn known_draft_cancel_after_target_dissolves_is_forbidden(pool: PgPool) {
    let t = f::tenant(pool).await;
    let user = http::add_user(&t.owner, t.org, &["MEMBER"]).await;
    a::grant(&t, user).await;
    let unit = t.dept("폐지할 부서", t.sites[0]).await;
    let ctx = http::ctx(&t.owner, t.org, user, &["MEMBER"], None).await;
    let (status, created) = ctx.call("POST", f::CHANGES, Some(a::draft(unit))).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    sqlx::query("INSERT INTO org_unit_revisions(org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) SELECT org_id,org_unit_id,version+1,gen_random_uuid(),actor_id,payload_digest,attributes || '{\"status\":\"dissolved\"}',receipt FROM org_unit_revisions WHERE org_unit_id=$1 ORDER BY version DESC LIMIT 1")
        .bind(unit).execute(&t.owner).await.unwrap();
    let before = a::snapshot(&t).await;
    let path = format!("{}/{}/cancel", f::CHANGES, created["id"].as_str().unwrap());
    let (status, body) = ctx
        .call("POST", &path, Some(json!({"reason":"대상 폐지 후 취소"})))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    refusal(&body, "org_change.refuse.missing_grant");
    assert_eq!(a::snapshot(&t).await, before);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn convenience_writes_share_scoped_cedar_draft_admission(pool: PgPool) {
    let t = f::tenant(pool).await;
    let user = http::add_user(&t.owner, t.org, &["MEMBER"]).await;
    a::grant(&t, user).await;
    let ctx = http::ctx(&t.owner, t.org, user, &["MEMBER"], None).await;
    let unit = t.dept("기존 부서", t.sites[0]).await;
    for (method, path, body) in [
        (
            "POST",
            "/api/v1/org-units".to_owned(),
            Some(json!({"kind":"DEPARTMENT","parentId":t.sites[0],"name":"신설 부서"})),
        ),
        (
            "PATCH",
            format!("/api/v1/org-units/{unit}"),
            Some(json!({"name":"개편 부서"})),
        ),
        ("DELETE", format!("/api/v1/org-units/{unit}"), None),
    ] {
        let (status, body) = ctx.call(method, &path, body).await;
        assert_eq!(status, StatusCode::CREATED, "{method}: {body}");
        assert_eq!(body["status"], "DRAFT");
    }
    let lower = http::add_user(&t.owner, t.org, &["MEMBER"]).await;
    let lower = http::ctx(&t.owner, t.org, lower, &["MEMBER"], None).await;
    let foreign = t.other_entity_site().await;
    for (caller, target) in [(&lower, unit), (&ctx, foreign), (&ctx, Uuid::new_v4())] {
        for (method, path, body) in [
            (
                "POST",
                "/api/v1/org-units".to_owned(),
                Some(json!({"kind":"DEPARTMENT","parentId":target,"name":"신설 부서"})),
            ),
            (
                "PATCH",
                format!("/api/v1/org-units/{target}"),
                Some(json!({"name":"개편 부서"})),
            ),
            ("DELETE", format!("/api/v1/org-units/{target}"), None),
        ] {
            let before = a::snapshot(&t).await;
            let (status, body) = caller.call(method, &path, body).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method}: {body}");
            refusal(&body, "org_change.refuse.missing_grant");
            assert_eq!(a::snapshot(&t).await, before);
        }
    }
    let foreign = f::tenant(t.owner.clone()).await;
    let foreign_ctx = http::ctx(
        &t.owner,
        foreign.org,
        UserId::from_uuid(foreign.actor),
        &["SUPER_ADMIN"],
        None,
    )
    .await;
    for target in [unit, Uuid::new_v4()] {
        for (method, path, body) in [
            (
                "POST",
                "/api/v1/org-units".to_owned(),
                Some(json!({"kind":"DEPARTMENT","parentId":target,"name":"신설 부서"})),
            ),
            (
                "PATCH",
                format!("/api/v1/org-units/{target}"),
                Some(json!({"name":"개편 부서"})),
            ),
            ("DELETE", format!("/api/v1/org-units/{target}"), None),
        ] {
            let before = a::snapshot(&t).await;
            let foreign_before = a::snapshot(&foreign).await;
            let (status, body) = foreign_ctx.call(method, &path, body).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method}: {body}");
            refusal(&body, "not_found");
            assert_eq!(a::snapshot(&t).await, before);
            assert_eq!(a::snapshot(&foreign).await, foreign_before);
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_drafts_refuse_with_the_same_cedar_code(pool: PgPool) {
    let t = f::tenant(pool).await;
    let lower = http::add_user(&t.owner, t.org, &["MEMBER"]).await;
    let ctx = http::ctx(&t.owner, t.org, lower, &["MEMBER"], None).await;
    for (path, payload) in [
        ("/api/v1/regions", json!({"name":"권한 없는 조직"})),
        (
            "/api/v1/branches",
            json!({"name":"권한 없는 조직","region_id":Uuid::new_v4()}),
        ),
    ] {
        let before = a::snapshot(&t).await;
        let (status, body) = ctx.call("POST", path, Some(payload)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        refusal(&body, "org_change.refuse.missing_grant");
        assert_eq!(a::snapshot(&t).await, before);
    }
}
