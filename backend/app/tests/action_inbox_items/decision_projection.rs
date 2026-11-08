// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{http, org_change, person_fixtures};
use ::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

async fn item(ctx: &http::Ctx, id: Uuid) -> Value {
    let (status, body) = ctx.call("GET", "/api/v1/me/action-inbox", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == format!("org_change:{id}"))
        .unwrap_or_else(|| panic!("missing request: {body}"))
        .clone()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn inbox_decision_projection_matches_command_and_version(pool: PgPool) {
    let (org, maker) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    person_fixtures::bind_user_to_distinct_person(&pool, maker).await;
    let checker = org_change::actor(&pool, org).await;
    let (id, steps) = org_change::request(&pool, org, maker).await;
    let ctx = http::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    let row = item(&ctx, id).await;
    assert_eq!(row["can_decide"], true);
    assert!(row.get("cannot_reason").is_none(), "{row}");
    let (_, detail) = ctx
        .call("GET", &format!("/api/v1/org-changes/{id}"), None)
        .await;
    assert_eq!(row["version"], detail["version"]);
    assert!(row["version"].is_string());
    let (status, body) = ctx
        .call(
            "POST",
            &org_change::path(id, steps[0]),
            Some(json!({"decision":"APPROVED", "expected_version":row["version"]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let maker_ctx = http::ctx(&pool, org, maker, &["SUPER_ADMIN"], None).await;
    assert_ne!(item(&maker_ctx, id).await["version"], row["version"]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn inbox_decision_refusal_codes_match_command_without_writes(pool: PgPool) {
    let (org, _admin) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let maker = org_change::actor(&pool, org).await;
    let (id, steps) = org_change::request(&pool, org, maker).await;
    let ctx = http::ctx(&pool, org, maker, &["EXECUTIVE"], None).await;
    for code in [
        "org_change_sod_violation",
        "org_change.refuse.identity_unbound",
        "org_change.refuse.missing_grant",
    ] {
        if code.ends_with("identity_unbound") {
            sqlx::query("INSERT INTO person_binding_reviews(org_id,subject_kind,subject_id,reason,evidence) VALUES($1,'ACCOUNT',$2,'NUMBER_BIRTH_AMBIGUOUS','{}')")
                .bind(org)
                .bind(maker.as_uuid())
                .execute(&pool)
                .await
                .unwrap();
        }
        if code.ends_with("missing_grant") {
            sqlx::query(
                "UPDATE access_grants SET valid_to=now()-interval '1 second' WHERE account_id=$1",
            )
            .bind(maker.as_uuid())
            .execute(&pool)
            .await
            .unwrap();
        }
        let row = item(&ctx, id).await;
        assert_eq!(row["can_decide"], false, "{row}");
        assert_eq!(row["cannot_reason"], code, "{row}");
        for decision in ["APPROVED", "REJECTED"] {
            let before = org_change::snapshot(&pool, id).await;
            let (_, refused) = ctx
                .call(
                    "POST",
                    &org_change::path(id, steps[0]),
                    Some(json!({"decision":decision})),
                )
                .await;
            assert_eq!(refused["error"]["code"], row["cannot_reason"], "{refused}");
            assert_eq!(org_change::snapshot(&pool, id).await, before);
        }
    }
}
