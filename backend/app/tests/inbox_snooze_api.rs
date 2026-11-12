// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Postponing an inbox item: it leaves my list and counts until its date or
//! until I bring it back, and it is mine alone.

#[path = "inbox_snooze_api/counts.rs"]
mod counts;
#[path = "access_log_reads/support.rs"]
mod fixtures;
#[path = "support/http.rs"]
mod http;
#[allow(dead_code)]
#[path = "../../test-support/org_change_fixtures.rs"]
mod org_change_fixtures;
#[allow(dead_code)]
#[path = "../../test-support/person_fixtures.rs"]
mod person_fixtures;
#[path = "inbox_snooze_api/refusals.rs"]
mod refusals;
#[allow(dead_code)]
#[path = "access_log_review_flags/statements.rs"]
mod statements;

use ::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Date, Duration, OffsetDateTime};
use uuid::Uuid;

const INBOX: &str = "/api/v1/me/action-inbox";

fn today() -> Date {
    OffsetDateTime::now_utc()
        .to_offset(time::macros::offset!(+9))
        .date()
}

/// The Korean calendar day `offset` days from today, as the API writes dates.
fn day(offset: i64) -> String {
    (today() + Duration::days(offset)).to_string()
}

fn snooze(id: &str) -> String {
    format!("{INBOX}/items/{id}/snooze")
}

async fn list(ctx: &http::Ctx, query: &str) -> Value {
    let (status, page) = ctx.call("GET", &format!("{INBOX}{query}"), None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["unavailable"], json!([]), "{page}");
    page
}

fn ids(page: &Value) -> Vec<String> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect()
}

fn item<'a>(page: &'a Value, id: &str) -> Option<&'a Value> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == id)
}

async fn until(ctx: &http::Ctx, id: &str, date: &str) -> (StatusCode, Value) {
    ctx.call("POST", &snooze(id), Some(json!({ "until": date })))
        .await
}

async fn rows(pool: &PgPool, org: Uuid) -> i64 {
    http::count(pool, "action_inbox_snoozes", org).await
}

/// A grant waiting for its holder's confirmation is an item in the holder's inbox alone.
async fn notice(pool: &PgPool, org: Uuid, ops: Uuid, holder: Uuid) -> String {
    let role: Uuid = sqlx::query_scalar("INSERT INTO access_roles (org_id,name_ko,status,version,created_by) VALUES ($1,'미루기 검증','ACTIVE',1,$2) RETURNING id")
        .bind(org).bind(ops).fetch_one(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'미루기 검증','ACTIVE','SETUP',$3)")
        .bind(org).bind(role).bind(ops).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'hr_basic',ARRAY['view'])")
        .bind(org).bind(role).execute(pool).await.unwrap();
    let grant: Uuid = sqlx::query_scalar("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,'TENANT',now()-interval '1 day','SETUP','NEW_HIRE',$4) RETURNING id")
        .bind(org).bind(holder).bind(role).bind(ops).fetch_one(pool).await.unwrap();
    format!("grant_notice:{grant}")
}

/// An applied hire opens social insurance filings, due on a legal date, for everyone who files them.
async fn filings(pool: &PgPool, org: Uuid, actor: Uuid) {
    let employee = fixtures::seed_employee(pool, org).await;
    sqlx::query("INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,to_status,effective_date,comment,created_by,state) VALUES ($1,$2,'ONBOARD','ACTIVE',CURRENT_DATE::text,'filing',$3,'APPLIED')")
        .bind(org).bind(employee).bind(actor).execute(pool).await.unwrap();
}

fn filing(page: &Value) -> &Value {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["kind"] == "insurance_filing" && item.get("due").is_some())
        .unwrap_or_else(|| panic!("a filing with a legal date: {page}"))
}

/// The workbench lists the same work as the inbox.
async fn on_workbench(ctx: &http::Ctx, id: &str) -> bool {
    let (status, bench) = ctx.call("GET", "/api/v1/me/workbench", None).await;
    assert_eq!(status, StatusCode::OK, "{bench}");
    let actions = &bench["action_inbox"];
    assert_eq!(actions["status"], "ok", "{actions}");
    actions["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|action| action["id"] == id)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_snoozed_item_leaves_my_list_until_i_bring_it_back(pool: PgPool) {
    let (org, ops) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let holder = http::add_user(&pool, org, &[]).await;
    let id = notice(&pool, org, *ops.as_uuid(), *holder.as_uuid()).await;
    let ctx = http::ctx(&pool, org, holder, &[], None).await;

    let before = list(&ctx, "").await;
    assert_eq!(
        item(&before, &id).unwrap()["snooze"],
        json!({"allowed": true})
    );
    assert_eq!(
        before["counts"]["snoozed"],
        json!({"total": 0, "total_is_exact": true})
    );
    let monday = 7 - i64::from(today().weekday().number_days_from_monday());
    assert_eq!(
        before["snooze_presets"],
        json!([
            {"key": "short", "date": day(1)},
            {"key": "next_week", "date": day(monday)},
            {"key": "long", "date": day(7)},
        ])
    );
    let total = before["total"].as_u64().unwrap();

    let (status, body) = until(&ctx, &id, &day(3)).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    let after = list(&ctx, "").await;
    assert!(item(&after, &id).is_none(), "{after}");
    assert_eq!(after["total"], total - 1);
    assert_eq!(
        after["counts"]["snoozed"],
        json!({"total": 1, "total_is_exact": true})
    );
    let view = list(&ctx, "?snoozed=only").await;
    assert_eq!(ids(&view), std::slice::from_ref(&id));
    assert_eq!(
        view["items"][0]["snooze"],
        json!({"allowed": true, "until": day(3)})
    );

    assert!(!on_workbench(&ctx, &id).await);

    // Snoozing again moves the date.
    let (status, body) = until(&ctx, &id, &day(5)).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    assert_eq!(
        list(&ctx, "?snoozed=only").await["items"][0]["snooze"]["until"],
        day(5)
    );
    assert_eq!(rows(&pool, org).await, 1);

    // The record of a snoozed item still opens.
    let (status, body) = ctx
        .call("GET", &format!("{INBOX}/items/{id}/activity"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    for _ in 0..2 {
        let (status, body) = ctx.call("DELETE", &snooze(&id), None).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    }
    assert!(item(&list(&ctx, "").await, &id).is_some());
    assert!(on_workbench(&ctx, &id).await);
    assert_eq!(rows(&pool, org).await, 0);
    assert_eq!(http::audits(&pool, org, "action_inbox.snooze").await, 2);
    assert_eq!(http::audits(&pool, org, "action_inbox.unsnooze").await, 2);

    // A date that has come hides nothing, and the next command clears it.
    sqlx::query("INSERT INTO action_inbox_snoozes (org_id,account_id,item_id,until) VALUES ($1,$2,$3,$4::date)")
        .bind(org).bind(holder.as_uuid()).bind(&id).bind(day(0)).execute(&pool).await.unwrap();
    let woken = list(&ctx, "").await;
    assert!(item(&woken, &id).is_some(), "{woken}");
    assert_eq!(woken["counts"]["snoozed"]["total"], 0);
    assert_eq!(
        ctx.call("DELETE", &snooze(&id), None).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(rows(&pool, org).await, 0);

    // The presets follow the tenant's settings.
    sqlx::query("INSERT INTO tenant_setting_overrides (org_id,key,value,set_by,reason_code) VALUES ($1,'inbox.snooze.short_days','3',$2,'TEST'),($1,'inbox.snooze.long_days','30',$2,'TEST')")
        .bind(org).bind(ops.as_uuid()).execute(&pool).await.unwrap();
    let presets = list(&ctx, "").await["snooze_presets"].clone();
    assert_eq!(presets[0], json!({"key": "short", "date": day(3)}));
    assert_eq!(presets[2], json!({"key": "long", "date": day(30)}));

    // The snoozed view takes no other filter.
    for query in ["?snoozed=only&filter=turn", "?snoozed=only&attention=today"] {
        let (status, body) = ctx.call("GET", &format!("{INBOX}{query}"), None).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{query}: {body}");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn my_snooze_is_mine_alone(pool: PgPool) {
    let (org, first) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let second = http::add_user(&pool, org, &["SUPER_ADMIN"]).await;
    let holder = http::add_user(&pool, org, &[]).await;
    filings(&pool, org, *first.as_uuid()).await;
    let own = notice(&pool, org, *first.as_uuid(), *holder.as_uuid()).await;
    let mine = http::ctx(&pool, org, first, &["SUPER_ADMIN"], None).await;
    let theirs = http::ctx(&pool, org, second, &["SUPER_ADMIN"], None).await;
    let holder = http::ctx(&pool, org, holder, &[], None).await;

    // Two people hold the same filing: one postpones it, the other still has it.
    let shared = filing(&list(&mine, "?limit=200").await)["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        until(&mine, &shared, &day(1)).await.0,
        StatusCode::NO_CONTENT
    );
    assert!(item(&list(&mine, "?limit=200").await, &shared).is_none());
    let other = list(&theirs, "?limit=200").await;
    assert!(item(&other, &shared).is_some(), "{other}");
    assert_eq!(other["counts"]["snoozed"]["total"], 0);
    assert!(ids(&list(&theirs, "?snoozed=only").await).is_empty());
    // Bringing back their own (absent) snooze leaves mine alone.
    assert_eq!(
        theirs.call("DELETE", &snooze(&shared), None).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(rows(&pool, org).await, 1);
    assert!(item(&list(&mine, "?limit=200").await, &shared).is_none());

    // An item only its holder has: nobody else can postpone it or bring it back.
    assert_eq!(
        until(&holder, &own, &day(1)).await.0,
        StatusCode::NO_CONTENT
    );
    let (elsewhere, stranger) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let stranger = http::ctx(&pool, elsewhere, stranger, &["SUPER_ADMIN"], None).await;
    for outsider in [&theirs, &stranger] {
        for (status, body) in [
            until(outsider, &own, &day(2)).await,
            outsider.call("DELETE", &snooze(&own), None).await,
        ] {
            assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
            assert_eq!(body["error"]["code"], "lifecycle.refuse.scope", "{body}");
        }
    }
    assert!(ids(&list(&stranger, "?snoozed=only").await).is_empty());
    assert_eq!(rows(&pool, org).await, 2);
    assert_eq!(rows(&pool, elsewhere).await, 0);
    assert_eq!(ids(&list(&holder, "?snoozed=only").await), [own]);

    // The database keeps one tenant's rows from another's session.
    let runtime = http::role_pool(&pool, "console_rt", None).await;
    let mut tx = runtime.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(elsewhere.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM action_inbox_snoozes")
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    assert_eq!(visible, 0);
    let written = sqlx::query("INSERT INTO action_inbox_snoozes (org_id,account_id,item_id,until) VALUES ($1,$2,'work:x',CURRENT_DATE)")
        .bind(org).bind(first.as_uuid()).execute(tx.as_mut()).await;
    assert!(written.is_err(), "a row for another tenant must be refused");
}
