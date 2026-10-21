//! org-04, org-05, org-06, org-07: one 폐지 change moves its members (a
//! dated 전보 each, per-person destinations) and sub-부서 first, closes the
//! unit on its 시행일 with no tick list, and a merge keeps its successor.
//! Refusals write nothing.

use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use super::fixture::{CHANGES, HIRE, code, day, tenant};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_dissolution_moves_its_members_with_dated_transfers_and_closes_the_unit(pool: PgPool) {
    // regression: org-04 (no 발령, 영향 인원 0명) and org-05 (정리 0/6, still on the chart).
    let t = tenant(pool).await;
    let [hq, pangyo] = t.workplaces;
    let sales = t.dept("영업2팀", t.sites[0]).await;
    let part = t.dept("영업2-1파트", sales).await;
    let hr = t.dept("인사팀", t.sites[0]).await;
    let lab = t.dept("판교연구소", t.sites[1]).await;
    let jung = t.person("정영업", sales, hq, "ACTIVE").await;
    let kim = t.person("김영업", sales, hq, "ACTIVE").await;
    let away = t.person("휴직자", sales, hq, "ON_LEAVE").await;
    let ops = json!([
        {"op": "MOVE_ORG_UNIT", "orgUnitId": part, "parentId": t.sites[0]},
        {"op": "REASSIGN_ORG_UNIT", "fromOrgUnit": sales, "toOrgUnit": lab,
         "scope": {"company": "Co"}, "employeeIds": [kim]},
        {"op": "REASSIGN_ORG_UNIT", "fromOrgUnit": sales, "toOrgUnit": hr, "scope": {"company": "Co"}},
        {"op": "DISSOLVE_ORG_UNIT", "orgUnitId": sales},
    ]);
    let (status, applied) = t.change("DISSOLVE", sales, ops, &day(0)).await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    assert_eq!(
        applied["status"],
        json!("APPLIED"),
        "a 폐지 applies on its 시행일"
    );
    assert_eq!(applied["settlementItems"], json!([]), "no tick list");
    assert_eq!(
        applied["preflight"]["warnings"],
        json!([]),
        "no 공고·결재 reminder chip"
    );
    assert_eq!(
        applied["headcount"],
        json!(3),
        "the record counts the people it moved"
    );
    let id = Uuid::parse_str(applied["id"].as_str().unwrap()).unwrap();
    assert_eq!(t.head(sales).await.1["status"], json!("dissolved"));
    assert_eq!(
        t.head(part).await.1["parent_id"],
        json!(t.sites[0].to_string())
    );

    let today = day(0);
    let jung_events = t.events(jung).await;
    assert_eq!(jung_events.len(), 1, "정영업's 전보: {jung_events:?}");
    assert_eq!(jung_events[0].0, "TRANSFER");
    assert_eq!((jung_events[0].3, jung_events[0].4), (Some(id), Some(hr)));
    assert_eq!(t.unit_of(jung).await, Some(hr));
    assert_eq!(t.live(jung).await.len(), 1, "인사팀 is at 본사: no 전근");
    // Per-person destination across 사업장: a 전보 that is also a 전근.
    assert_eq!(t.events(kim).await[0].4, Some(lab));
    assert_eq!(
        t.live(kim).await,
        [
            (HIRE.to_owned(), Some(today.clone()), hq, "HIRE".to_owned()),
            (today.clone(), None, pangyo, "TRANSFER".to_owned()),
        ]
    );
    // 휴직 (hr refuses a TRANSFER) still leaves with the unit; the record stays whole.
    assert_eq!(t.unit_of(away).await, Some(hr));
    assert!(t.events(away).await.is_empty());
    assert!(t.mismatches().await.is_empty());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_merge_keeps_its_successor(pool: PgPool) {
    // regression: org-07 — recorded as a bare 폐지, the successor lost.
    let t = tenant(pool).await;
    let three = t.dept("영업3팀", t.sites[0]).await;
    let hr = t.dept("인사팀", t.sites[0]).await;
    let ops = json!([{"op": "DISSOLVE_ORG_UNIT", "orgUnitId": three, "mergedInto": hr}]);
    let (status, applied) = t.change("DISSOLVE", three, ops, &day(0)).await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    let (_, attributes) = t.head(three).await;
    assert_eq!(attributes["status"], json!("dissolved"));
    assert_eq!(attributes["merged_into"], json!(hr.to_string()));
    assert_eq!(applied["proposal"][0]["mergedInto"], json!(hr.to_string()));
    // The unit's own history reads the successor (org-17: its 이력 says what happened).
    let (status, unit) = t
        .ops
        .send("GET", &format!("/api/v1/org-units/{three}"), None, false)
        .await;
    assert_eq!(status, StatusCode::OK, "{unit}");
    assert_eq!(unit["revisions"][0]["mergedInto"], json!(hr.to_string()));
    assert_eq!(unit["revisions"][0]["status"], json!("DISSOLVED"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn refusals_write_nothing(pool: PgPool) {
    let t = tenant(pool).await;
    let [_, pangyo] = t.workplaces;
    let dev = t.dept("개발팀", t.sites[1]).await;
    let park = t.person("박개발", dev, pangyo, "ACTIVE").await;
    let lee = t.person("이개발", dev, pangyo, "ACTIVE").await;

    // A unit never crosses 법인: moving it under another 법인's 사업장 is refused whole.
    let foreign = t.other_entity_site().await;
    let ops = json!([{"op": "MOVE_ORG_UNIT", "orgUnitId": dev, "parentId": foreign}]);
    let id = t.draft("REORG", dev, ops, &day(0)).await;
    let (status, body) = t
        .ops
        .send("POST", &format!("{CHANGES}/{id}/submit"), None, false)
        .await;
    // UX-R3 org-01: submit's own dry run names it (preflight == submit), with the code as the reason.
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(code(&body), "preflight_blocked");
    assert_eq!(body["error"]["reasons"], json!(["transfer_cross_entity"]));
    assert_eq!(
        t.request(&id).await["status"],
        json!("DRAFT"),
        "the submit rolled back"
    );
    assert_eq!(t.head(dev).await.0, 1, "the unit did not move");
    assert!(t.events(park).await.is_empty() && t.events(lee).await.is_empty());
    assert_eq!(t.live(park).await.len(), 1);
    assert_eq!(
        t.audits("org_change.submit").await,
        0,
        "no audit of a rolled-back submit"
    );

    // A 폐지 that leaves a member behind is blocked before anything is written.
    let hr = t.dept("인사팀", t.sites[1]).await;
    let ops = json!([
        {"op": "REASSIGN_ORG_UNIT", "fromOrgUnit": dev, "toOrgUnit": hr,
         "scope": {"company": "Co"}, "employeeIds": [park]},
        {"op": "DISSOLVE_ORG_UNIT", "orgUnitId": dev},
    ]);
    let (status, body) = t.change("DISSOLVE", dev, ops, &day(0)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(code(&body), "preflight_blocked");
    assert_eq!(t.unit_of(park).await, Some(dev), "nobody moved");
    assert_eq!(t.head(dev).await.1["status"], json!("active"));

    // A merge into a unit that is gone is refused, and the source stays.
    let gone = t.dept("해산팀", t.sites[1]).await;
    let ops = json!([{"op": "DISSOLVE_ORG_UNIT", "orgUnitId": gone}]);
    assert_eq!(
        t.change("DISSOLVE", gone, ops, &day(0)).await.0,
        StatusCode::OK
    );
    let solo = t.dept("단독팀", t.sites[1]).await;
    let ops = json!([{"op": "DISSOLVE_ORG_UNIT", "orgUnitId": solo, "mergedInto": gone}]);
    let (status, body) = t.change("DISSOLVE", solo, ops, &day(0)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(t.head(solo).await.1["status"], json!("active"));
}
