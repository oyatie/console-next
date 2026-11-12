// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "support/http.rs"]
mod http;
use ::http::StatusCode;
use sqlx::PgPool;
use uuid::Uuid;

/// A grant waiting for its holder's confirmation is an item in the holder's inbox; returns its grant id.
async fn granted(pool: &PgPool, org: Uuid, ops: Uuid, holder: Uuid) -> Uuid {
    let role: Uuid = sqlx::query_scalar("INSERT INTO access_roles (org_id,name_ko,status,version,created_by) VALUES ($1,'활동 검증','ACTIVE',1,$2) RETURNING id")
        .bind(org).bind(ops).fetch_one(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'활동 검증','ACTIVE','SETUP',$3)")
        .bind(org).bind(role).bind(ops).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'hr_basic',ARRAY['view'])")
        .bind(org).bind(role).execute(pool).await.unwrap();
    sqlx::query_scalar("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,'TENANT',now()-interval '1 day','SETUP','NEW_HIRE',$4) RETURNING id")
        .bind(org).bind(holder).bind(role).bind(ops).fetch_one(pool).await.unwrap()
}

async fn audited(
    pool: &PgPool,
    org: Uuid,
    actor: Option<Uuid>,
    action: &str,
    target: Uuid,
    minutes_ago: i64,
) {
    sqlx::query(
        "INSERT INTO audit_events (id,actor,action,target_type,target_id,before_snap,after_snap,trace_id,span_id,occurred_at,org_id) \
         VALUES (gen_random_uuid(),$1,$2,'access_grants',$3,'{\"secret\":\"before-snapshot\"}','{\"secret\":\"after-snapshot\"}', \
                 '0123456789abcdef0123456789abcdef','0123456789abcdef',now()-($4 * interval '1 minute'),$5)",
    )
    .bind(actor).bind(action).bind(target.to_string()).bind(minutes_ago).bind(org)
    .execute(pool).await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_items_activity_is_who_what_and_when_for_its_holder_only(pool: PgPool) {
    let (org, ops) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let holder = http::add_user(&pool, org, &[]).await;
    let other = http::add_user(&pool, org, &[]).await;
    let grant = granted(&pool, org, *ops.as_uuid(), *holder.as_uuid()).await;
    audited(
        &pool,
        org,
        Some(*ops.as_uuid()),
        "access.grant.create",
        grant,
        10,
    )
    .await;
    audited(&pool, org, None, "access.grant.expire_check", grant, 5).await;
    audited(
        &pool,
        org,
        Some(*ops.as_uuid()),
        "access.grant.create",
        Uuid::new_v4(),
        1,
    )
    .await;
    let path = format!("/api/v1/me/action-inbox/items/grant_notice:{grant}/activity");

    let ctx = http::ctx(&pool, org, holder, &[], None).await;
    let (status, body) = ctx.call("GET", &path, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let items = body["items"].as_array().unwrap();
    assert_eq!(
        items.len(),
        2,
        "only the item's own events, newest first: {body}"
    );
    assert_eq!(items[0]["verb"], "other");
    assert!(
        items[0].get("actor_name").is_none(),
        "a system event names no one: {body}"
    );
    assert_eq!(items[1]["verb"], "create");
    assert!(
        items[1]["actor_name"]
            .as_str()
            .is_some_and(|name| !name.is_empty()),
        "{body}"
    );
    assert!(
        !body.to_string().contains("snapshot"),
        "snapshots are never served: {body}"
    );

    // Someone else's item, an unknown item and a malformed id are one 404.
    let outsider = http::ctx(&pool, org, other, &[], None).await;
    for (ctx, path) in [
        (&outsider, path.clone()),
        (
            &ctx,
            format!(
                "/api/v1/me/action-inbox/items/grant_notice:{}/activity",
                Uuid::new_v4()
            ),
        ),
        (
            &ctx,
            "/api/v1/me/action-inbox/items/not-an-id/activity".to_owned(),
        ),
    ] {
        let (status, body) = ctx.call("GET", &path, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}: {body}");
        assert_eq!(
            body["error"]["code"], "inbox_item_not_found",
            "{path}: {body}"
        );
    }

    // Another tenant's holder of the same id sees nothing either.
    let (elsewhere, _) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let stranger = http::add_user(&pool, elsewhere, &[]).await;
    let (status, body) = http::ctx(&pool, elsewhere, stranger, &[], None)
        .await
        .call("GET", &path, None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
}
