//! org-02: a scheduled change can be cancelled (예약 취소) and moved (예약
//! 수정), and applies on its 시행일 with nobody pressing 시행 — once.

use console_app::org_change_schedule::apply_due_org_changes;
use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;

use super::fixture::{CHANGES, HIRE, code, day, tenant, today};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_scheduled_change_is_cancelled_moved_and_applied_on_its_date(pool: PgPool) {
    // regression: org-02 — no 예약 취소, never applied by itself.
    let t = tenant(pool).await;
    let [hq, pangyo] = t.workplaces;
    let support = t.dept("경영지원본부", t.sites[0]).await;
    let dev = t.dept("개발팀", t.sites[1]).await;
    let park = t.person("박개발", dev, pangyo, "ACTIVE").await;
    let move_dev = json!([{"op": "MOVE_ORG_UNIT", "orgUnitId": dev, "parentId": support}]);

    // 예약 취소.
    let (status, scheduled) = t.change("REORG", dev, move_dev.clone(), &day(7)).await;
    assert_eq!(status, StatusCode::OK, "{scheduled}");
    assert_eq!(scheduled["status"], json!("APPROVED"));
    let id = scheduled["id"].as_str().unwrap().to_owned();
    let cancel = json!({"reason": "일정 변경"});
    let (status, cancelled) = t
        .ops
        .send(
            "POST",
            &format!("{CHANGES}/{id}/cancel"),
            Some(cancel),
            false,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{cancelled}");
    assert_eq!(cancelled["status"], json!("CANCELLED"));
    assert_eq!(t.audits("org_change.cancel").await, 1);
    assert_eq!(
        apply_due_org_changes(&t.owner, today() + time::Duration::days(7)).await,
        Ok(0)
    );
    assert_eq!(t.head(dev).await.0, 1, "a cancelled change never applies");

    // 예약 수정: the content stays, the date moves; a content change is refused.
    let (_, scheduled) = t.change("REORG", dev, move_dev, &day(7)).await;
    let id = scheduled["id"].as_str().unwrap().to_owned();
    let path = format!("{CHANGES}/{id}");
    let (status, moved) = t
        .ops
        .send(
            "PATCH",
            &path,
            Some(json!({"effectiveDate": day(3)})),
            false,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(
        (moved["status"].clone(), moved["effectiveDate"].clone()),
        (json!("APPROVED"), json!(day(3)))
    );
    let other = json!({"proposal": [{"op": "RENAME_ORG_UNIT", "orgUnitId": dev, "name": "X"}]});
    let (status, body) = t.ops.send("PATCH", &path, Some(other), false).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(code(&body), "org_change_scheduled_content");
    assert_eq!(
        t.request(&id).await["proposal"][0]["op"],
        json!("MOVE_ORG_UNIT")
    );

    // Under routing, someone who may not apply cannot touch an approved change.
    t.route_org_changes().await;
    let admin = t.caller("ADMIN").await;
    let (status, body) = admin
        .send(
            "POST",
            &format!("{CHANGES}/{id}/cancel"),
            Some(json!({"reason": "x"})),
            false,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(code(&body), "org_change_scheduled_locked");
    let (status, _) = admin
        .send(
            "PATCH",
            &path,
            Some(json!({"effectiveDate": day(5)})),
            false,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(t.request(&id).await["status"], json!("APPROVED"));
    assert_eq!(t.request(&id).await["effectiveDate"], json!(day(3)));
    assert_eq!(
        t.audits("org_change.cancel").await,
        1,
        "the refused cancel wrote nothing"
    );

    // The worker applies it on its 시행일, with the people, once.
    let on = today() + time::Duration::days(3);
    assert_eq!(
        apply_due_org_changes(&t.owner, on - time::Duration::days(1)).await,
        Ok(0)
    );
    assert_eq!(apply_due_org_changes(&t.owner, on).await, Ok(1));
    assert_eq!(
        apply_due_org_changes(&t.owner, on).await,
        Ok(0),
        "idempotent"
    );
    assert_eq!(t.request(&id).await["status"], json!("APPLIED"));
    assert_eq!(
        t.live(park).await,
        [
            (HIRE.to_owned(), Some(day(3)), pangyo, "HIRE".to_owned()),
            (day(3), None, hq, "TRANSFER".to_owned()),
        ]
    );
    let events = t.events(park).await;
    assert_eq!(
        (events[0].1.as_str(), events[0].2.as_str()),
        ("APPLIED", day(3).as_str())
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_due_change_that_cannot_apply_says_why_once_and_stays_scheduled(pool: PgPool) {
    let t = tenant(pool).await;
    let [_, pangyo] = t.workplaces;
    let dev = t.dept("개발팀", t.sites[1]).await;
    let park = t.person("박개발", dev, pangyo, "ACTIVE").await;
    let foreign = t.other_entity_site().await;
    let ops = json!([{"op": "MOVE_ORG_UNIT", "orgUnitId": dev, "parentId": foreign}]);
    let (status, scheduled) = t.change("REORG", dev, ops, &day(2)).await;
    assert_eq!(status, StatusCode::OK, "{scheduled}");
    let id = scheduled["id"].as_str().unwrap().to_owned();
    let on = today() + time::Duration::days(2);
    for _ in 0..2 {
        assert_eq!(apply_due_org_changes(&t.owner, on).await, Ok(0));
    }
    let record = t.request(&id).await;
    assert_eq!(
        record["status"],
        json!("APPROVED"),
        "still 예약: 수정 or 취소 is offered"
    );
    let refused: Vec<_> = record["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["action"] == json!("effectuate.refused"))
        .collect();
    assert_eq!(refused.len(), 1, "the reason is recorded once: {record}");
    assert_eq!(t.head(dev).await.0, 1, "nothing applied");
    assert!(t.events(park).await.is_empty());
}
