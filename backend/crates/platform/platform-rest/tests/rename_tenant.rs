//! Company-domain rename through the platform API, with fresh passkey proof.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "fixtures/rename.rs"]
mod fixture;
use console_kernel_core::OrgId;
use console_platform_rest::PLATFORM_ORGS_PATH;
#[path = "fixtures/domain_requests.rs"]
mod domain_requests;
use fixture::Harness;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;
/// (`error.code`, `error.errors[0].field`) of a refusal.
fn refusal(body: &Value) -> (Option<&str>, Option<&str>) {
    let error = &body["error"];
    (error["code"].as_str(), error["errors"][0]["field"].as_str())
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_tenant_is_renamed_and_its_slug_stays_unique(owner: PgPool) {
    let h = Harness::new(owner).await;
    let acme = h.onboard("acme").await;
    let beta = h.onboard("beta").await;

    // Rename both fields; the response is the updated org, the audit row keeps before/after.
    let (status, body) = h
        .patch(
            acme,
            json!({ "name": "에이스 물류", "slug": "ace-logistics" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        (body["slug"].as_str(), body["name"].as_str()),
        (Some("ace-logistics"), Some("에이스 물류"))
    );
    let (before, after): (Value, Value) = h
        .read("SELECT before_snap, after_snap FROM audit_events WHERE action = 'platform.tenant.rename' AND org_id = $1", acme)
        .await;
    assert_eq!(before, json!({ "slug": "acme", "name": "Tenant acme" }));
    assert_eq!(
        after,
        json!({ "slug": "ace-logistics", "name": "에이스 물류" })
    );

    // Name only keeps the slug.
    let (status, body) = h.patch(beta, json!({ "name": "Beta Co" })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(h.org(beta).await.0, "beta");

    // A taken slug: 409 slug_taken on rename and on create (was a 500).
    let (status, body) = h.patch(beta, json!({ "slug": "ace-logistics" })).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(refusal(&body), (Some("slug_taken"), Some("slug")));
    let (status, body) = h
        .send(
            "POST",
            PLATFORM_ORGS_PATH,
            json!({ "slug": "beta", "name": "Again" }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"].as_str(), Some("slug_taken"));

    // A slug outside the CHECK: 422 slug_invalid on rename and on create; nothing changed.
    for bad in ["Has_Upper", "ab", "trailing-"] {
        let (status, body) = h.patch(beta, json!({ "slug": bad })).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}: {body}");
        assert_eq!(refusal(&body), (Some("slug_invalid"), Some("slug")));
    }
    let (status, body) = h
        .send(
            "POST",
            PLATFORM_ORGS_PATH,
            json!({ "slug": "x", "name": "X" }),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("slug_invalid"))
    );
    assert_eq!(
        h.org(beta).await,
        ("beta".into(), "Beta Co".into(), "ACTIVE".into())
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn status_and_rename_share_the_route_without_half_applied_changes(owner: PgPool) {
    let h = Harness::new(owner).await;
    let acme = h.onboard("acme").await;

    // The pa-polish UI body {status} still works.
    let (status, body) = h.patch(acme, json!({ "status": "SUSPENDED" })).await;
    assert_eq!(
        (status, body["status"].as_str()),
        (StatusCode::OK, Some("SUSPENDED"))
    );

    // A bad status refuses the whole request before the rename.
    let (status, _) = h
        .patch(acme, json!({ "status": "GONE", "name": "Renamed" }))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(h.org(acme).await.1, "Tenant acme");

    // Both at once.
    let (status, body) = h
        .patch(acme, json!({ "status": "ACTIVE", "name": "Renamed" }))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        h.org(acme).await,
        ("acme".into(), "Renamed".into(), "ACTIVE".into())
    );

    // Nothing to change, an empty name, an unknown tenant, the platform sentinel.
    assert_eq!(
        h.patch(acme, json!({})).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        h.patch(acme, json!({ "name": "  " })).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        h.patch(Uuid::new_v4(), json!({ "name": "Nobody" })).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.patch(Uuid::new_v4(), json!({ "status": "ACTIVE" }))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let sentinel = *OrgId::platform().as_uuid();
    assert_eq!(
        h.patch(sentinel, json!({ "slug": "vendor" })).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.patch(sentinel, json!({ "status": "ACTIVE" })).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.org(sentinel).await,
        (
            "platform".into(),
            "Platform (vendor tier)".into(),
            "ARCHIVED".into()
        )
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_rename_needs_an_enrolled_operator_passkey(owner: PgPool) {
    let h = Harness::new(owner).await;
    let acme = h.onboard("acme").await;
    sqlx::query("DELETE FROM auth_webauthn_credentials WHERE org_id = $1")
        .bind(*OrgId::platform().as_uuid())
        .execute(&h.owner)
        .await
        .unwrap();
    let (status, _) = h.patch(acme, json!({ "slug": "acme-2" })).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(h.org(acme).await.0, "acme");
    // A status change never needed one (unchanged behaviour).
    assert_eq!(
        h.patch(acme, json!({ "status": "SUSPENDED" })).await.0,
        StatusCode::OK
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn domain_change_requires_fresh_proof_without_writing_or_notifying(owner: PgPool) {
    let h = Harness::new(owner).await;
    let id = h.onboard("fresh-proof").await;
    let (status, body) = h
        .send(
            "PATCH",
            &format!("{PLATFORM_ORGS_PATH}/{id}"),
            json!({"slug":"fresh-new"}),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["code"], "unauthorized");
    assert_eq!(h.org(id).await.0, "fresh-proof");
    let (audit, notices): (i64, i64) = h.read("SELECT (SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='platform.tenant.rename'), (SELECT count(*) FROM notifications WHERE org_id=$1 AND category='tenant.domain.change')", id).await;
    assert_eq!((audit, notices), (0, 0));
    let (_, result) = h
        .send(
            "GET",
            "/api/platform/company-domain?slug=fresh-proof",
            Value::Null,
        )
        .await;
    assert_eq!(result["available"], false);
    let (status, body) = h
        .send("GET", "/api/platform/company-domain?slug=bad_", Value::Null)
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["error"]["code"], "slug_invalid");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_and_lower_grant_tokens_cannot_check_or_change_domains(owner: PgPool) {
    let h = Harness::new(owner).await;
    let org_id = h.onboard("private-domain").await;
    let tenant_user: uuid::Uuid =
        sqlx::query_scalar("SELECT id FROM users WHERE org_id=$1 LIMIT 1")
            .bind(org_id)
            .fetch_one(&h.owner)
            .await
            .unwrap();
    let lower = console_platform_test_support::seed_active_user(
        &h.owner,
        *OrgId::platform().as_uuid(),
        "MEMBER",
        "Limited operator",
    )
    .await;
    let tenant_token = h
        .token_for(
            console_kernel_core::UserId::from_uuid(tenant_user),
            OrgId::from_uuid(org_id),
            false,
            vec!["SUPER_ADMIN".into()],
        )
        .await;
    let lower_token = h
        .token_for(lower, OrgId::platform(), true, vec!["MEMBER".into()])
        .await;
    for (token, expected_status, expected_code) in [
        (tenant_token, StatusCode::FORBIDDEN, "forbidden"),
        (lower_token, StatusCode::UNAUTHORIZED, "unauthorized"),
    ] {
        for (method, uri, body) in [
            (
                "GET",
                "/api/platform/company-domain?slug=private-domain".to_owned(),
                Value::Null,
            ),
            (
                "PATCH",
                format!("{PLATFORM_ORGS_PATH}/{org_id}"),
                json!({"slug":"stolen-domain"}),
            ),
        ] {
            let (status, body) = h.send_as(method, &uri, body, &token).await;
            assert_eq!(status, expected_status, "{body}");
            assert_eq!(body["error"]["code"], expected_code);
            assert!(body.get("available").is_none());
            let checks: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM audit_events WHERE action='platform.tenant.domain.check'",
            )
            .fetch_one(&h.owner)
            .await
            .unwrap();
            assert_eq!(checks, 0);
        }
    }
    assert_eq!(h.org(org_id).await.0, "private-domain");
    let (audit,): (i64,) = h
        .read(
            "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='platform.tenant.rename'",
            org_id,
        )
        .await;
    assert_eq!(audit, 0);
}
