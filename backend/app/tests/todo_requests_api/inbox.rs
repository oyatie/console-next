// SPDX-License-Identifier: LicenseRef-Proprietary
//! A request in the work inbox: the assignee owes it (their turn), the
//! requester follows it (waiting), and nobody else sees it. Done and withdrawn
//! requests leave both inboxes; a returned one stays with its requester.

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::format_description::well_known::Rfc3339;
use time::{Date, Duration, OffsetDateTime};
use uuid::Uuid;

use crate::support::{Ctx, add_user, ctx, today_kst};
use crate::{Office, REQUESTS, office};

pub const INBOX: &str = "/api/v1/me/action-inbox";
/// A synthetic request text; the marker is what the log and audit checks look for.
pub const TEXT: &str = "Synthetic ask QX41: confirm the March attendance close";
pub const NOTE: &str = "Synthetic note ZR77: outside my permissions";

/// Gives `ctx`'s account a display name of its own and returns the name the inbox reads.
pub async fn named(pool: &PgPool, ctx: &Ctx, name: &str) -> String {
    sqlx::query("UPDATE users SET display_name = $2 WHERE id = $1")
        .bind(ctx.user.as_uuid())
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query_scalar("SELECT display_name FROM person_accounts_current WHERE id = $1")
        .bind(ctx.user.as_uuid())
        .fetch_one(pool)
        .await
        .unwrap()
}

/// The administrator asks `to`; returns the request id.
pub async fn ask(o: &Office, to: &Ctx, due_on: Option<Date>, links: Value) -> String {
    let body = json!({
        "assignee_account_id": to.user.as_uuid(),
        "text": TEXT,
        "due_on": due_on.map(|d| d.to_string()),
        "links": links,
    });
    let (status, made) = o.admin.call("POST", REQUESTS, Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    made["id"].as_str().unwrap().to_owned()
}

pub fn today() -> Date {
    Date::parse(
        &today_kst(),
        time::macros::format_description!("[year]-[month]-[day]"),
    )
    .unwrap()
}

/// The caller's inbox, with every source read.
pub async fn inbox(ctx: &Ctx, query: &str) -> Value {
    let (status, page) = ctx.call("GET", &format!("{INBOX}{query}"), None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["unavailable"], json!([]), "{page}");
    page
}

/// The page's to-do request items.
pub fn requests(page: &Value) -> Vec<Value> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["kind"].as_str().unwrap().starts_with("todo_"))
        .cloned()
        .collect()
}

pub fn ids(page: &Value) -> Vec<String> {
    requests(page)
        .iter()
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect()
}

pub fn item(page: &Value, id: &str) -> Option<Value> {
    requests(page).into_iter().find(|item| item["id"] == id)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn each_party_sees_only_their_own_side_of_a_request(pool: PgPool) {
    let o = office(pool).await;
    let asker = named(&o.pool, &o.admin, "Synthetic asker").await;
    let owner = named(&o.pool, &o.colleague, "Synthetic assignee").await;
    let employee = Uuid::new_v4();
    let id = ask(
        &o,
        &o.colleague,
        Some(today()),
        json!([{ "kind": "employee", "id": employee }]),
    )
    .await;
    let (status, own) = o
        .colleague
        .call(
            "POST",
            "/api/v1/me/todos",
            Some(json!({ "text": "Synthetic private memo" })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{own}");
    let own = own["id"].as_str().unwrap();

    let page = inbox(&o.colleague, "").await;
    assert_eq!(ids(&page), [format!("todo_assigned:{id}")], "{page}");
    let mine = requests(&page).remove(0);
    assert_eq!(
        (&mine["kind"], &mine["lane"], &mine["title"], &mine["who"]),
        (
            &json!("todo_assigned"),
            &json!("turn"),
            &json!(TEXT),
            &json!(asker)
        )
    );
    let due = OffsetDateTime::parse(mine["due"].as_str().unwrap(), &Rfc3339).unwrap();
    let end_of_day = today()
        .with_hms_micro(23, 59, 59, 999_999)
        .unwrap()
        .assume_offset(time::macros::offset!(+9));
    assert_eq!(due, end_of_day, "the end of the due day in Korea");
    assert!(mine.get("due_basis").is_none(), "a wish, not a legal date");
    assert_eq!(
        mine["links"],
        json!([{ "kind": "todo", "id": id }, { "kind": "employee", "id": employee }])
    );
    assert!(mine.get("context").is_none() && mine.get("version").is_none());
    assert!(!page.to_string().contains(own), "a private todo is no item");

    let page = inbox(&o.admin, "").await;
    assert_eq!(ids(&page), [format!("todo_requested:{id}")], "{page}");
    let asked = requests(&page).remove(0);
    assert_eq!(
        (&asked["lane"], &asked["who"], &asked["dueTone"]),
        (&json!("waiting"), &json!(owner), &json!("neutral"))
    );
    assert_eq!(asked["context"], json!({ "todo": { "state": "open" } }));
    assert_eq!(asked["version"], json!("open"));

    for (ctx, filter, want) in [
        (&o.colleague, "turn", vec![format!("todo_assigned:{id}")]),
        (&o.colleague, "waiting", vec![]),
        (&o.admin, "turn", vec![]),
        (&o.admin, "waiting", vec![format!("todo_requested:{id}")]),
    ] {
        let page = inbox(ctx, &format!("?filter={filter}")).await;
        assert_eq!(ids(&page), want, "{filter}: {page}");
    }

    let third = add_user(&o.pool, o.org, &[]).await;
    let third = ctx(&o.pool, o.org, third, &[], None).await;
    assert!(ids(&inbox(&third, "").await).is_empty());

    let other = office(o.pool.clone()).await;
    let theirs = ask(&other, &other.colleague, None, json!([])).await;
    for (reader, want) in [
        (&other.colleague, format!("todo_assigned:{theirs}")),
        (&other.admin, format!("todo_requested:{theirs}")),
    ] {
        let page = inbox(reader, "").await;
        assert_eq!(ids(&page), [want]);
        assert!(!page.to_string().contains(&id), "{page}");
    }
    for reader in [&o.colleague, &o.admin] {
        assert!(!inbox(reader, "").await.to_string().contains(&theirs));
    }
}

/// The inbox ids of request `id`, the colleague's then the administrator's.
async fn listed(o: &Office, id: String) -> Vec<String> {
    let mut seen = ids(&inbox(&o.colleague, "").await);
    seen.extend(ids(&inbox(&o.admin, "").await));
    seen.retain(|seen| seen.ends_with(&id));
    seen
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn done_return_and_withdraw_move_the_items(pool: PgPool) {
    let o = office(pool).await;
    let both = |id: &str| {
        [
            format!("todo_assigned:{id}"),
            format!("todo_requested:{id}"),
        ]
    };
    let listed = |id: &str| listed(&o, id.to_owned());

    let done = ask(&o, &o.colleague, None, json!([])).await;
    assert_eq!(listed(&done).await, both(&done));
    let (status, out) = o
        .colleague
        .call(
            "POST",
            &format!("/api/v1/me/todos/{done}/done"),
            Some(json!({ "done": true })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert!(listed(&done).await.is_empty(), "done leaves both inboxes");

    let back = ask(&o, &o.colleague, None, json!([])).await;
    let requested = format!("todo_requested:{back}");
    let open = item(&inbox(&o.admin, "").await, &requested).unwrap();
    let (status, out) = o
        .colleague
        .call(
            "POST",
            &format!("/api/v1/me/todos/{back}/return"),
            Some(json!({ "note": NOTE })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{out}");
    assert_eq!(
        listed(&back).await,
        std::slice::from_ref(&requested),
        "only the requester's stays"
    );
    let returned = item(&inbox(&o.admin, "").await, &requested).unwrap();
    assert_eq!(
        returned["context"],
        json!({ "todo": { "state": "returned", "return_note": NOTE } })
    );
    assert_eq!(returned["lane"], "waiting");
    assert_ne!(returned["version"], open["version"]);
    let (status, out) = o
        .admin
        .call("DELETE", &format!("{REQUESTS}/{back}"), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{out}");
    assert!(
        listed(&back).await.is_empty(),
        "clearing it leaves the inbox"
    );

    let taken = ask(&o, &o.colleague, None, json!([])).await;
    assert_eq!(listed(&taken).await, both(&taken));
    let (status, out) = o
        .admin
        .call("DELETE", &format!("{REQUESTS}/{taken}"), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{out}");
    assert!(listed(&taken).await.is_empty(), "a withdrawal leaves both");
}

/// The whole-inbox count a page reports, with its exactness.
fn everything(page: &Value) -> (Value, Value) {
    let all = page["attention_filters"]
        .as_array()
        .unwrap()
        .iter()
        .find(|count| count["key"] == "all")
        .unwrap();
    (all["total"].clone(), all["total_is_exact"].clone())
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn counts_are_exact_and_paging_walks_every_request(pool: PgPool) {
    let o = office(pool).await;
    let sides = [(&o.colleague, "turn"), (&o.admin, "waiting")];
    let mut before = Vec::new();
    for (ctx, lane) in sides {
        let page = inbox(ctx, "").await;
        before.push((
            page["counts"][lane]["total"].as_u64().unwrap(),
            everything(&page).0.as_u64().unwrap(),
        ));
    }
    let later = today() + Duration::days(3);
    let mut made = Vec::new();
    for due in [None, Some(later), None, Some(today()), None] {
        made.push((due, ask(&o, &o.colleague, due, json!([])).await));
    }
    // Due first and undated last; the asks were made in order, so creation breaks the ties.
    let mut want: Vec<_> = made
        .iter()
        .enumerate()
        .map(|(n, (due, id))| (due.is_none(), *due, n, format!("todo_assigned:{id}")))
        .collect();
    want.sort();
    let want: Vec<String> = want.into_iter().map(|(.., id)| id).collect();

    for ((ctx, lane), &(lane_before, all_before)) in sides.into_iter().zip(&before) {
        let page = inbox(ctx, "").await;
        assert_eq!(requests(&page).len(), 5, "{page}");
        assert_eq!(
            page["counts"][lane],
            json!({ "total": lane_before + 5, "total_is_exact": true }),
            "{lane}"
        );
        assert_eq!(everything(&page), (json!(all_before + 5), json!(true)));
    }

    // Every page counts the whole inbox, not the rows it holds or those after its cursor.
    let whole = everything(&inbox(&o.colleague, "?limit=2").await);
    let mut walked = Vec::new();
    let mut query = "?limit=2".to_owned();
    loop {
        let page = inbox(&o.colleague, &query).await;
        assert!(page["items"].as_array().unwrap().len() <= 2);
        assert_eq!(everything(&page), whole, "{query}");
        walked.extend(ids(&page));
        match page["next_cursor"].as_str() {
            Some(next) => query = format!("?limit=2&cursor={next}"),
            None => break,
        }
    }
    assert_eq!(walked, want, "every request once, in due order");
    assert_eq!(whole, (json!(before[0].1 + 5), json!(true)));
}
