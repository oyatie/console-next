// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "support/http.rs"]
mod http;
use ::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;

const EVENTS: &str = "/api/v1/collaboration/calendar/events";
fn event(scope: &str, title: &str) -> Value {
    json!({"scope_type":scope, "title":title, "starts_at":"2026-08-15T09:00:00+09:00", "ends_at":"2026-08-15T10:00:00+09:00"})
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn members_see_only_mounted_calendar_and_their_own_personal_events(pool: PgPool) {
    let (org, member) = http::tenant(&pool, &["MEMBER"]).await;
    sqlx::query("INSERT INTO tenant_module_enrollments (org_id,module_key,enabled,change_ref) VALUES ($1,'calendar',true,'test-enrollment') ON CONFLICT DO NOTHING")
        .bind(org).execute(&pool).await.unwrap();
    let colleague = http::add_user(&pool, org, &["MEMBER"]).await;
    let caller = http::ctx(&pool, org, member, &["MEMBER"], None).await;
    let other = http::ctx(&pool, org, colleague, &["MEMBER"], None).await;
    let (status, projection) = caller.call("GET", "/api/v1/me/authz", None).await;
    assert_eq!(status, StatusCode::OK, "{projection}");
    let caps = projection["capabilities"].as_array().unwrap();
    assert_eq!(
        caps.iter().any(|cap| cap["feature"] == "served_calendar"),
        cfg!(feature = "workspace")
    );
    assert!(
        !caps
            .iter()
            .any(|cap| cap["feature"] == "notice_manage" && cap["permission"] == "allow")
    );
    let route =
        format!("{EVENTS}?from=2026-08-01T00%3A00%3A00Z&to=2026-08-30T00%3A00%3A00Z&limit=2");
    let (status, original) = caller.call("GET", &route, None).await;
    if !cfg!(feature = "workspace") {
        assert_eq!(status, StatusCode::NOT_FOUND);
        return;
    }
    assert_eq!(status, StatusCode::OK, "{original}");
    assert_eq!(original["items"], json!([]));
    for title in ["Alpha", "Beta", "Gamma"] {
        let mut body = event("PERSONAL", title);
        body["scope_ref"] = json!(colleague.as_uuid());
        let (status, value) = caller.call("POST", EVENTS, Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{value}");
        assert_eq!(value["scope_ref"], json!(member.as_uuid().to_string()));
    }
    let (status, page) = caller.call("GET", &route, None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["items"].as_array().unwrap().len(), 2);
    let cursor = page["next_cursor"].as_str().expect("first page cursor");
    // New rows after the first read belong to the next snapshot. The last page contains only
    // the third original item, even with a tied start time across all four events.
    let (status, body) = caller
        .call("POST", EVENTS, Some(event("PERSONAL", "Later")))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let encoded = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("cursor", cursor)
        .finish();
    let (status, last) = caller
        .call("GET", &format!("{route}&{encoded}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{last}");
    assert_eq!(last["items"].as_array().unwrap().len(), 1);
    assert!(last["next_cursor"].is_null());
    let mut all = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .chain(last["items"].as_array().unwrap())
        .map(|item| item["title"].as_str().unwrap())
        .collect::<Vec<_>>();
    all.sort_unstable();
    assert_eq!(all, ["Alpha", "Beta", "Gamma"]);
    let (status, body) = other.call("GET", &route, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["items"], json!([]));
    let (status, body) = caller
        .call("POST", EVENTS, Some(event("TENANT", "Internal")))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let counts: (i64,i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM collaboration_calendar_events WHERE org_id=$1), (SELECT count(*) FROM collaboration_calendar_event_events WHERE org_id=$1), (SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='collaboration.calendar_event.create')")
        .bind(org).fetch_one(&pool).await.unwrap();
    assert_eq!(counts, (4, 4, 4));
}

#[cfg(feature = "workspace")]
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn branch_publishers_and_org_publishers_address_only_authorized_audiences(pool: PgPool) {
    let (org, admin) = http::tenant(&pool, &["ADMIN"]).await;
    sqlx::query("INSERT INTO tenant_module_enrollments (org_id,module_key,enabled,change_ref) VALUES ($1,'calendar',true,'test-enrollment') ON CONFLICT DO NOTHING")
        .bind(org).execute(&pool).await.unwrap();
    let org_admin = http::add_user(&pool, org, &["EXECUTIVE"]).await;
    let branches: Vec<uuid::Uuid> = sqlx::query_scalar("WITH r AS (INSERT INTO regions (org_id,name) VALUES ($1,'North') RETURNING id) INSERT INTO branches (org_id,region_id,name) SELECT $1,r.id,t.name FROM r CROSS JOIN (VALUES ('Central'),('East')) t(name) RETURNING id")
        .bind(org).fetch_all(&pool).await.unwrap();
    sqlx::query("INSERT INTO user_branches(user_id,branch_id,org_id) VALUES ($1,$2,$3)")
        .bind(admin.as_uuid())
        .bind(branches[0])
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();
    let branch_ctx = http::ctx(&pool, org, admin, &["ADMIN"], None).await;
    let org_ctx = http::ctx(&pool, org, org_admin, &["EXECUTIVE"], None).await;
    for (ctx, wide) in [(&branch_ctx, false), (&org_ctx, true)] {
        let (_, projection) = ctx.call("GET", "/api/v1/me/authz", None).await;
        let publish = projection["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|cap| cap["feature"] == "notice_manage")
            .unwrap();
        assert_eq!(publish["permission"], "allow");
        assert_eq!(publish["org_wide"], wide);
        for (scope, target, allowed) in [
            ("TENANT", None, wide),
            ("ORG", None, wide),
            ("TEAM", Some("Research".to_owned()), wide),
            ("DEPARTMENT", Some(branches[0].to_string()), true),
            ("DEPARTMENT", Some(branches[1].to_string()), wide),
        ] {
            let mut body = event(scope, "Internal schedule");
            if let Some(target) = target {
                body["scope_ref"] = json!(target);
            }
            let (status, response) = ctx.call("POST", EVENTS, Some(body)).await;
            assert_eq!(
                status,
                if allowed {
                    StatusCode::OK
                } else {
                    StatusCode::FORBIDDEN
                },
                "{scope}: {response}"
            );
        }
    }
}
