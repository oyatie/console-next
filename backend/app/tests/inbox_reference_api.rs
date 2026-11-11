// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! 참조: the notices addressed to me, newest first, and 확인 that marks one read.

#[path = "support/http.rs"]
mod http;

use ::http::StatusCode;
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

const REFERENCE: &str = "/api/v1/me/action-inbox/reference";

async fn notice(pool: &PgPool, org: Uuid, to: Uuid, body: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO notifications (org_id, recipient_user_id, category, body, link) \
         VALUES ($1, $2, 'tenant.go_live', $3, jsonb_build_object('type','screen','screen','settings/audit')) RETURNING id",
    )
    .bind(org)
    .bind(to)
    .bind(body)
    .fetch_one(pool)
    .await
    .unwrap()
}

fn ids(page: &Value) -> Vec<String> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].as_str().unwrap().to_owned())
        .collect()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn my_notices_list_newest_first_and_only_i_can_mark_mine_read(pool: PgPool) {
    let (org, me) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, me, &["SUPER_ADMIN"], None).await;
    let other = http::add_user(&pool, org, &[]).await;
    let other_ctx = http::ctx(&pool, org, other, &[], None).await;
    let first = notice(&pool, org, *me.as_uuid(), "운영을 시작했습니다").await;
    let second = notice(&pool, org, *me.as_uuid(), "회사 도메인이 바뀌었습니다").await;
    let theirs = notice(&pool, org, *other.as_uuid(), "다른 사람의 안내").await;

    let (status, page) = ctx.call("GET", REFERENCE, None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let mine = ids(&page);
    assert_eq!(mine.len(), 2, "{page}");
    assert!(mine.contains(&first.to_string()) && mine.contains(&second.to_string()));
    assert!(
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["unread"] == true)
    );

    // 확인 marks mine read; another person's notice is 404 and stays unread.
    let (status, read) = ctx
        .call("POST", &format!("{REFERENCE}/{first}/read"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{read}");
    assert_eq!(read["unread"], false);
    let (status, refused) = ctx
        .call("POST", &format!("{REFERENCE}/{theirs}/read"), None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{refused}");
    let (_, theirs_page) = other_ctx.call("GET", REFERENCE, None).await;
    assert_eq!(ids(&theirs_page), [theirs.to_string()]);
    assert_eq!(theirs_page["items"][0]["unread"], true);

    let (_, unread) = ctx
        .call("GET", &format!("{REFERENCE}?unread=true"), None)
        .await;
    assert_eq!(ids(&unread), [second.to_string()], "{unread}");

    // Another tenant sees none of it.
    let (other_org, stranger) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let stranger = http::ctx(&pool, other_org, stranger, &["SUPER_ADMIN"], None).await;
    let (_, none) = stranger.call("GET", REFERENCE, None).await;
    assert!(ids(&none).is_empty(), "{none}");
}
