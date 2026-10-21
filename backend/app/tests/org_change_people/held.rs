//! UX-R3 STRUCT org-16: a unit held by an open org change names that change
//! as its one blocker on the end options (with its code, to link), even when
//! people are still in it; before, it said 「구성원 1명이 아직 있습니다」.

use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;

use super::fixture::{CHANGES, day, tenant};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_a_held_unit_names_its_change_as_the_blocker(pool: PgPool) {
    // regression: r3 org-16 — the held 품질팀's 폐지 row gave its members as the reason.
    let t = tenant(pool).await;
    let [_, pangyo] = t.workplaces;
    let qa = t.dept("품질팀", t.sites[1]).await;
    t.person("최품질", qa, pangyo, "ACTIVE").await;
    let uri = format!("/api/v1/org-structure/units/{qa}/end-options");
    let (status, free) = t.ops.call("GET", &uri, None).await;
    assert_eq!(status, StatusCode::OK, "{free}");
    assert_eq!(free["dissolve"]["refusal"], json!("org_unit_has_members"));
    assert!(free["held_by"].is_null(), "{free}");

    let ops = json!([{"op": "RENAME_ORG_UNIT", "orgUnitId": qa, "name": "품질보증팀"}]);
    let id = t.draft("REORG", qa, ops, &day(3)).await;
    let (_, change) = t.ops.call("GET", &format!("{CHANGES}/{id}"), None).await;
    let (status, held) = t.ops.call("GET", &uri, None).await;
    assert_eq!(status, StatusCode::OK, "{held}");
    assert_eq!(held["dissolve"]["refusal"], json!("org_unit_change_open"));
    assert_eq!(held["held_by"]["id"], json!(id));
    assert_eq!(held["held_by"]["code"], change["code"]);
}
