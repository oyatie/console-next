// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Asking a colleague for a follow-up, through the real router as `console_rt`:
//! who may ask, every refusal (status, code, nothing written, nothing audited),
//! a request's forward-only life, and a private todo staying private.

#[path = "support/go_live.rs"]
mod go_live;
#[path = "support/http.rs"]
mod support;
#[path = "scope_ax5/world.rs"]
mod world;

#[path = "todo_requests_api/grants.rs"]
mod grants;
#[path = "todo_requests_api/life.rs"]
mod life;
#[path = "todo_requests_api/refusals.rs"]
mod refusals;

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use support::{Ctx, add_user, audits, count, ctx, tenant};

pub const REQUESTS: &str = "/api/v1/me/todos/requests";

/// A live tenant: its sole administrator (the ops account) and one colleague
/// holding no role and no grant.
pub struct Office {
    pub pool: PgPool,
    pub org: Uuid,
    pub admin: Ctx,
    pub colleague: Ctx,
}

pub async fn office(pool: PgPool) -> Office {
    let (org, admin) = tenant(&pool, &["SUPER_ADMIN"]).await;
    go_live::go_live(&pool, org).await;
    let colleague = add_user(&pool, org, &[]).await;
    Office {
        admin: ctx(&pool, org, admin, &["SUPER_ADMIN"], None).await,
        colleague: ctx(&pool, org, colleague, &[], None).await,
        pool,
        org,
    }
}

impl Office {
    /// The administrator asks `to` for a follow-up; returns the request id.
    pub async fn ask(&self, to: &Ctx) -> String {
        let (status, made) = self.admin.call("POST", REQUESTS, Some(ask_body(to))).await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
        made["id"].as_str().unwrap().to_owned()
    }

    /// Todo rows and todo audit rows of this tenant.
    pub async fn written(&self) -> (i64, i64) {
        let audited: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_events WHERE org_id = $1 AND action LIKE 'todo.%'",
        )
        .bind(self.org)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        (count(&self.pool, "todos", self.org).await, audited)
    }
}

pub fn ask_body(to: &Ctx) -> Value {
    json!({ "assignee_account_id": to.user.as_uuid(), "text": "3월 근태 마감 확인 부탁드립니다" })
}

pub fn code(v: &Value) -> &str {
    v["error"]["code"].as_str().unwrap_or_default()
}

/// The raw response body, to compare bytes rather than parsed values.
pub async fn raw_get(ctx: &Ctx, uri: &str) -> Vec<u8> {
    let request = Request::builder()
        .method("GET")
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {}", ctx.token))
        .body(Body::empty())
        .unwrap();
    let response = ctx.service.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_sole_administrator_asks_a_colleague_after_go_live_with_no_grant(pool: PgPool) {
    let office = office(pool).await;
    let body = json!({
        "assignee_account_id": office.colleague.user.as_uuid(),
        "text": "3월 근태 마감 확인 부탁드립니다",
        "due_on": support::today_kst(),
        "links": [{ "kind": "employee", "id": Uuid::new_v4(), "label": "a label is never stored" }],
    });
    let (status, made) = office.admin.call("POST", REQUESTS, Some(body)).await;

    assert_eq!(status, StatusCode::CREATED, "{made}");
    assert_eq!(
        made["owner_user_id"],
        json!(office.colleague.user.as_uuid())
    );
    assert_eq!(
        made["assigned_by_user_id"],
        json!(office.admin.user.as_uuid())
    );
    assert_eq!(made["due_on"], json!(support::today_kst()));
    assert!(made["links"][0].get("label").is_none(), "{made}");
    let (owner, by, label): (Uuid, Uuid, Option<String>) = sqlx::query_as(
        "SELECT owner_user_id, assigned_by_user_id, links->0->>'label' FROM todos WHERE org_id = $1",
    )
    .bind(office.org)
    .fetch_one(&office.pool)
    .await
    .unwrap();
    assert_eq!(
        (owner, by),
        (
            *office.colleague.user.as_uuid(),
            *office.admin.user.as_uuid()
        )
    );
    assert_eq!(label, None);
    assert_eq!(audits(&office.pool, office.org, "todo.request").await, 1);
    let after: Value = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE org_id = $1 AND action = 'todo.request'",
    )
    .bind(office.org)
    .fetch_one(&office.pool)
    .await
    .unwrap();
    assert_eq!(
        after,
        json!({ "assignee_user_id": office.colleague.user.as_uuid(), "due_on": support::today_kst() }),
        "the audit names who was asked and when, never the text or a link"
    );

    let (status, mine) = office
        .admin
        .call("GET", &format!("{REQUESTS}?state=open"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{mine}");
    assert_eq!(mine["items"][0]["id"], made["id"]);
}

/// The workbench reads the owner's todos through its own snapshot query.
#[cfg(feature = "workspace")]
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn requests_stay_off_the_workbench(pool: PgPool) {
    let office = office(pool).await;
    let own = json!({ "text": "개인 메모: 서류 정리" });
    let (status, own) = office
        .colleague
        .call("POST", "/api/v1/me/todos", Some(own))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{own}");
    let asked = office.ask(&office.colleague).await;
    let (status, bench) = office
        .colleague
        .call("GET", "/api/v1/me/workbench", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{bench}");
    let todos = bench["todos"].to_string();
    assert!(todos.contains(own["id"].as_str().unwrap()), "{todos}");
    assert!(!todos.contains(&asked), "{todos}");
}
