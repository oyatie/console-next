// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{INBOX, day, http, ids, item, list, org_change_fixtures, statements, until};
use ::http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use tracing::instrument::WithSubscriber;
use tracing_subscriber::prelude::*;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn counts_and_rows_agree_with_two_hundred_items_and_three_snoozes(pool: PgPool) {
    tracing_subscriber::registry().try_init().ok();
    let (org, maker) = http::tenant(&pool, &["MEMBER"]).await;
    http::add_user(&pool, org, &["MEMBER"]).await;
    org_change_fixtures::grant_org_levels(&pool, maker, &["view", "edit"]).await;
    let ctx = http::ctx(&pool, org, maker, &["MEMBER"], None).await;
    // Whatever else the account holds counts toward the two hundred.
    let other = list(&ctx, "?limit=200").await["total"].as_i64().unwrap();
    sqlx::query("INSERT INTO org_change_requests(org_id,code,kind,status,target_kind,target_ref,target_label,effective_date,reason,proposal,drafted_by,idempotency_key,request_fingerprint) SELECT $1,'OC-2026-'||lpad(n::text,4,'0'),'REORG','IN_APPROVAL','REGION','region','Reorganization',CURRENT_DATE + 30,'Review','[]',$2,gen_random_uuid()::text,repeat('a',64) FROM generate_series(1,$3::int) n")
        .bind(org).bind(maker.as_uuid()).bind(200 - other).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO org_change_approval_steps(org_id,request_id,step_order,role_key) SELECT org_id,id,1,'hr' FROM org_change_requests WHERE org_id=$1")
        .bind(org).execute(&pool).await.unwrap();
    let all = list(&ctx, "?limit=200").await;
    let waiting = |page: &serde_json::Value| -> Vec<String> {
        ids(page)
            .into_iter()
            .filter(|id| id.starts_with("org_change:"))
            .collect()
    };
    let changes = waiting(&all);
    assert_eq!(all["items"].as_array().unwrap().len(), 200, "{all}");
    assert_eq!(all["total"], 200);
    assert!(changes.len() > 190, "{other} other items");
    for id in &changes[..3] {
        let (status, body) = until(&ctx, id, &day(3)).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    }

    // The account's snoozes are read once, before any source runs.
    let statements = statements::Statements::default();
    let (status, page) = ctx
        .call("GET", &format!("{INBOX}?limit=200"), None)
        .with_subscriber(statements.dispatch())
        .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let queries = statements.take();
    assert_eq!(
        queries
            .iter()
            .filter(|sql| sql.contains("action_inbox_snoozes"))
            .count(),
        1,
        "{queries:#?}"
    );
    let shown = page["items"].as_array().unwrap().len();
    assert_eq!(shown, 197);
    assert_eq!(page["total"], shown, "{}", page["attention_filters"]);
    assert_eq!(page["total_is_exact"], true);
    assert_eq!(
        page["attention_filters"][0],
        json!({"key": "all", "total": shown, "total_is_exact": true})
    );
    assert_eq!(
        page["counts"]["waiting"],
        json!({"total": changes.len() - 3, "total_is_exact": true})
    );
    assert_eq!(
        page["counts"]["snoozed"],
        json!({"total": 3, "total_is_exact": true})
    );
    assert_eq!(waiting(&page), changes[3..]);
    assert!(page["next_cursor"].is_null());
    assert_eq!(waiting(&list(&ctx, "?snoozed=only").await), changes[..3]);

    // Someone acts on a postponed request: it returns at once.
    let acted: Uuid = changes[0].rsplit_once(':').unwrap().1.parse().unwrap();
    sqlx::query("UPDATE org_change_requests SET updated_at = updated_at + interval '1 minute' WHERE id = $1")
        .bind(acted)
        .execute(&pool)
        .await
        .unwrap();
    let woken = list(&ctx, "?limit=200").await;
    assert!(item(&woken, &changes[0]).is_some());
    assert_eq!(woken["counts"]["snoozed"]["total"], 2);
    assert_eq!(waiting(&list(&ctx, "?snoozed=only").await), changes[1..3]);
}
