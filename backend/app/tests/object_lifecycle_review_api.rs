// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "support/http.rs"]
mod http;
use ::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

async fn read(ctx: &http::Ctx, path: &str) -> Value {
    let (status, value) = ctx.call("GET", path, None).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    value
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn actor_and_retention_checked_successors_match_the_live_transition(pool: PgPool) {
    let (org, maker) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let checker = http::add_user(&pool, org, &["SUPER_ADMIN"]).await;
    let member = http::add_user(&pool, org, &["MEMBER"]).await;
    let maker = http::ctx(&pool, org, maker, &["SUPER_ADMIN"], None).await;
    let checker = http::ctx(&pool, org, checker, &["SUPER_ADMIN"], None).await;
    let member = http::ctx(&pool, org, member, &["MEMBER"], None).await;
    let (other_org, other) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let other = http::ctx(&pool, other_org, other, &["SUPER_ADMIN"], None).await;
    let path = format!("/api/v1/lifecycles/document/{}", Uuid::new_v4());
    let hold = format!("{path}/hold");
    let transition = format!("{path}/transition");
    assert_eq!(
        maker.call("GET", &path, None).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        maker
            .call("POST", &hold, Some(json!({"legalHold":true})))
            .await
            .0,
        StatusCode::OK
    );
    let draft = read(&maker, &path).await;
    assert_eq!(draft["availableTransitions"], json!(["submitted"]));
    assert_eq!(draft["transitions"], json!([]));
    assert_eq!(
        member.call("GET", &path, None).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        other.call("GET", &path, None).await.0,
        StatusCode::NOT_FOUND
    );
    let change = |to: &str| Some(json!({"toState":to,"reason":"Records review"}));
    assert_eq!(
        maker.call("POST", &transition, change("submitted")).await.0,
        StatusCode::OK
    );
    assert_eq!(read(&maker, &path).await["availableTransitions"], json!([]));
    assert_eq!(
        maker.call("POST", &transition, change("approved")).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        read(&checker, &path).await["availableTransitions"],
        json!(["approved"])
    );
    for step in ["approved", "active", "revised", "archived"] {
        let (status, value) = checker.call("POST", &transition, change(step)).await;
        assert_eq!(status, StatusCode::OK, "{step}: {value}");
    }
    assert_eq!(
        read(&checker, &path).await["availableTransitions"],
        json!([])
    );
    assert_eq!(
        checker
            .call("POST", &transition, change("disposed"))
            .await
            .0,
        StatusCode::CONFLICT
    );
    // A different authorized editor's changes survive submission of the stale form.
    assert_eq!(
        maker
            .call(
                "POST",
                &hold,
                Some(json!({"legalHold":false,"expectedUpdatedAt":draft["updatedAt"]}))
            )
            .await
            .0,
        StatusCode::CONFLICT
    );
    let current = read(&maker, &path).await;
    assert_eq!(current["legalHold"], true);
    let (status,_) = maker.call("POST",&hold,Some(json!({"legalHold":false,"retentionUntil":"2999-01-01","expectedUpdatedAt":current["updatedAt"]}))).await;
    assert_eq!(status, StatusCode::OK);
    let retained = read(&maker, &path).await;
    assert_eq!(retained["availableTransitions"], json!([]));
    assert_eq!(
        maker
            .call(
                "POST",
                &hold,
                Some(json!({"legalHold":false,"expectedUpdatedAt":retained["updatedAt"]}))
            )
            .await
            .0,
        StatusCode::OK
    );
    let cleared = read(&maker, &path).await;
    assert_eq!(cleared["availableTransitions"], json!(["disposed"]));
    assert_eq!(cleared["transitions"][0]["toState"], "archived");
    assert_eq!(
        maker.call("POST", &transition, change("disposed")).await.0,
        StatusCode::OK
    );
    assert_eq!(read(&maker, &path).await["availableTransitions"], json!([]));
}
