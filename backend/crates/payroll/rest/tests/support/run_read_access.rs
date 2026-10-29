// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

use super::pay_view::grant_view;

pub(super) async fn get_unauthenticated(service: axum::Router, uri: &str) -> StatusCode {
    let request = Request::builder()
        .uri(uri)
        .method("GET")
        .body(Body::empty())
        .unwrap();
    service.oneshot(request).await.unwrap().status()
}

async fn assert_refused(service: &axum::Router, token: &str, run: Uuid) {
    for path in [
        PAYROLL_RUNS_PATH.to_owned(),
        format!("{PAYROLL_RUNS_PATH}/{run}"),
    ] {
        let response = get(service.clone(), &path, token).await;
        assert_eq!(
            response.status,
            StatusCode::FORBIDDEN,
            "{path}: {}",
            response.json
        );
        assert_eq!(response.json["error"]["code"], "forbidden");
        assert!(response.json.get("items").is_none());
        assert!(response.json.get("run").is_none());
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_roles_alone_cannot_read_runs(pool: PgPool) {
    let org = OrgId::one();
    let keys = keys();
    let stager = UserId::new();
    seed_user(&pool, stager, *org.as_uuid(), "SUPER_ADMIN").await;
    let run = seed_run(&pool, *org.as_uuid(), stager).await;
    let service = app(runtime_role_pool(&pool).await, &keys);
    for role in ["SUPER_ADMIN", "EXECUTIVE"] {
        let actor = UserId::new();
        seed_user(&pool, actor, *org.as_uuid(), role).await;
        let token = bearer(&pool, &keys, actor, org, role).await;
        assert_refused(&service, &token, run).await;
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pay_view_grant_allows_run_reads_and_revocation_is_immediate(pool: PgPool) {
    let org = OrgId::one();
    let keys = keys();
    let stager = UserId::new();
    seed_user(&pool, stager, *org.as_uuid(), "SUPER_ADMIN").await;
    let run = seed_run(&pool, *org.as_uuid(), stager).await;
    let actor = UserId::new();
    seed_user(&pool, actor, *org.as_uuid(), "MEMBER").await;
    let grant = grant_view(&pool, org, actor, None).await;
    let token = bearer(&pool, &keys, actor, org, "MEMBER").await;
    let service = app(runtime_role_pool(&pool).await, &keys);
    let listed = get(service.clone(), PAYROLL_RUNS_PATH, &token).await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.json);
    assert_eq!(listed.json["total"], 1);
    assert_eq!(listed.json["items"][0]["id"], json!(run));
    let detail = get(
        service.clone(),
        &format!("{PAYROLL_RUNS_PATH}/{run}"),
        &token,
    )
    .await;
    assert_eq!(detail.status, StatusCode::OK, "{}", detail.json);
    assert_eq!(detail.json["run"]["id"], json!(run));

    // rls-arming: ok owner revokes the fixture grant between requests using the same session.
    sqlx::query(
        "UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=$2 WHERE id=$1",
    )
    .bind(grant)
    .bind(actor.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    assert_refused(&service, &token, run).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn entity_only_pay_view_cannot_widen_to_tenant_run_reads(pool: PgPool) {
    let org = OrgId::one();
    let keys = keys();
    let actor = UserId::new();
    seed_user(&pool, actor, *org.as_uuid(), "EXECUTIVE").await;
    let run = seed_run(&pool, *org.as_uuid(), actor).await;
    let entity = Uuid::new_v4();
    // rls-arming: ok owner seeds a legal entity solely for the narrow-grant fixture.
    sqlx::query("INSERT INTO legal_entities (org_id,id,needs_confirmation,created_change_mode) VALUES ($1,$2,true,'MIGRATION')")
        .bind(org.as_uuid()).bind(entity).execute(&pool).await.unwrap();
    grant_view(&pool, org, actor, Some(entity)).await;
    let token = bearer(&pool, &keys, actor, org, "EXECUTIVE").await;
    let service = app(runtime_role_pool(&pool).await, &keys);
    assert_refused(&service, &token, run).await;
}
