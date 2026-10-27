// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{http, org_change, person_fixtures};
use ::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

async fn turns(ctx: &http::Ctx, id: Uuid) -> usize {
    let (status, body) = ctx
        .call("GET", "/api/v1/me/action-inbox?filter=turn", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(
        !body["unavailable"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s == "org_change"),
        "{body}"
    );
    let items = body["items"].as_array().unwrap();
    items
        .iter()
        .filter(|i| i["id"] == format!("org_change:{id}"))
        .count()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn inbox_turns_and_decisions_share_live_cedar_and_person_facts(pool: PgPool) {
    let (org, maker) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    person_fixtures::bind_user_to_distinct_person(&pool, maker).await;
    let checker = org_change::actor(&pool, org).await;
    let (id, steps) = org_change::request(&pool, org, maker).await;
    let ctx = http::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    assert_eq!(turns(&ctx, id).await, 1);
    assert_eq!(
        ctx.call(
            "POST",
            &org_change::path(id, steps[0]),
            Some(json!({"decision":"APPROVED"}))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        turns(&ctx, id).await,
        0,
        "prior decider must not be offered approval"
    );
    let person: Uuid = sqlx::query_scalar("SELECT person_id FROM users WHERE id=$1")
        .bind(checker.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    let alias = org_change::actor(&pool, org).await;
    person_fixtures::bind_user_to_person(&pool, alias, person).await;
    let alias_ctx = http::ctx(&pool, org, alias, &["EXECUTIVE"], None).await;
    assert_eq!(turns(&alias_ctx, id).await, 0);
    let independent = org_change::actor(&pool, org).await;
    let independent_ctx = http::ctx(&pool, org, independent, &["EXECUTIVE"], None).await;
    assert_eq!(turns(&independent_ctx, id).await, 1);
    let (foreign_org, foreign) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let foreign_ctx = http::ctx(&pool, foreign_org, foreign, &["SUPER_ADMIN"], None).await;
    assert_eq!(turns(&foreign_ctx, id).await, 0);
    let before = org_change::snapshot(&pool, id).await;
    let (status, _) = foreign_ctx
        .call(
            "POST",
            &org_change::path(id, steps[1]),
            Some(json!({"decision":"APPROVED"})),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(org_change::snapshot(&pool, id).await, before);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn missing_and_expired_grants_have_a_stable_403_without_writes(pool: PgPool) {
    let (org, maker) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    person_fixtures::bind_user_to_distinct_person(&pool, maker).await;
    let checker = org_change::actor(&pool, org).await;
    let (id, steps) = org_change::request(&pool, org, maker).await;
    sqlx::query("UPDATE access_grants SET valid_to=now()-interval '1 second' WHERE account_id=$1")
        .bind(checker.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let lower = http::add_user(&pool, org, &["MEMBER"]).await;
    for (actor, role) in [(checker, "EXECUTIVE"), (lower, "MEMBER")] {
        let ctx = http::ctx(&pool, org, actor, &[role], None).await;
        assert_eq!(
            turns(&ctx, id).await,
            0,
            "no grant must mean no approval turn"
        );
        for extra in [
            json!({}),
            json!({"expected_version":"stale"}),
            json!({"through_step":steps[1]}),
        ] {
            for decision in ["APPROVED", "REJECTED"] {
                let mut body: Value = extra.clone();
                body["decision"] = json!(decision);
                let before = org_change::snapshot(&pool, id).await;
                let (status, refused) = ctx
                    .call("POST", &org_change::path(id, steps[0]), Some(body))
                    .await;
                assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
                org_change::assert_legacy_error(&refused);
                assert_eq!(refused["error"]["code"], "org_change.refuse.missing_grant");
                assert!(
                    refused["error"]["support_ref"]
                        .as_str()
                        .is_some_and(|s| !s.is_empty())
                );
                assert_eq!(org_change::snapshot(&pool, id).await, before);
            }
        }
    }
}
