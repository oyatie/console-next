//! org-01: a 부서 moved under another 사업장 takes its people with it, each as
//! a dated 전근 caused by the org change; a move inside the 사업장 records no
//! 전근; the data check finds nobody whose 사업장 contradicts their 부서.

use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;

use super::fixture::{HIRE, day, tenant};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn moving_a_dept_to_another_workplace_moves_its_people_as_dated_transfers(pool: PgPool) {
    // regression: org-01 (P0) — the unit moved, its people stayed at 판교.
    let t = tenant(pool).await;
    let [hq, pangyo] = t.workplaces;
    let support = t.dept("경영지원본부", t.sites[0]).await;
    let dev = t.dept("개발팀", t.sites[1]).await;
    let squad = t.dept("플랫폼파트", dev).await;
    let park = t.person("박개발", dev, pangyo, "ACTIVE").await;
    let lee = t.person("이개발", squad, pangyo, "ACTIVE").await;
    let leave = t.person("휴직자", dev, pangyo, "ON_LEAVE").await;
    let stay = t.person("판교직원", t.sites[1], pangyo, "ACTIVE").await;

    let ops = json!([{"op": "MOVE_ORG_UNIT", "orgUnitId": dev, "parentId": support}]);
    let (status, applied) = t.change("REORG", dev, ops, &day(0)).await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    assert_eq!(applied["status"], json!("APPLIED"));
    let id = applied["id"].as_str().unwrap().to_owned();

    let today = day(0);
    for person in [park, lee, leave] {
        assert_eq!(
            t.live(person).await,
            [
                (
                    HIRE.to_owned(),
                    Some(today.clone()),
                    pangyo,
                    "HIRE".to_owned()
                ),
                (today.clone(), None, hq, "TRANSFER".to_owned()),
            ],
            "the person's 사업장 follows the 부서 from the 시행일"
        );
    }
    // The active people carry a dated 전근 caused by (batched under) the change.
    let cause = uuid::Uuid::parse_str(&id).unwrap();
    for (person, unit) in [(park, dev), (lee, squad)] {
        let events = t.events(person).await;
        assert_eq!(events.len(), 1, "{events:?}");
        assert_eq!(events[0].0, "TRANSFER");
        assert_eq!(events[0].1, "APPLIED");
        assert_eq!(events[0].2, today);
        assert_eq!(events[0].3, Some(cause));
        assert_eq!(
            t.unit_of(person).await,
            Some(unit),
            "the 부서 itself is unchanged"
        );
    }
    // Nobody else moved; the record counts the people the change moved.
    assert_eq!(t.live(stay).await.len(), 1);
    assert_eq!(t.request(&id).await["headcount"], json!(3));
    assert_eq!(
        t.mismatches().await,
        Vec::<uuid::Uuid>::new(),
        "the data check is clean"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_move_inside_the_workplace_records_no_transfer(pool: PgPool) {
    let t = tenant(pool).await;
    let [_, pangyo] = t.workplaces;
    let lab = t.dept("연구소", t.sites[1]).await;
    let dev = t.dept("개발팀", t.sites[1]).await;
    let park = t.person("박개발", dev, pangyo, "ACTIVE").await;
    let ops = json!([{"op": "MOVE_ORG_UNIT", "orgUnitId": dev, "parentId": lab}]);
    let (status, applied) = t.change("REORG", dev, ops, &day(0)).await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    assert_eq!(
        t.live(park).await.len(),
        1,
        "same 사업장: the assignment stays whole"
    );
    assert!(
        t.events(park).await.is_empty(),
        "no 전근 when the 사업장 is the same"
    );
    assert_eq!(applied["headcount"], json!(0));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn created_units_keep_the_projected_operation_identity_in_canonical_receipts(pool: PgPool) {
    let t = tenant(pool).await;
    let ops = json!([
        {"op":"CREATE_ORG_UNIT","kind":"DEPARTMENT","parentId":t.sites[0],"name":"First"},
        {"op":"CREATE_ORG_UNIT","kind":"DEPARTMENT","parentId":t.sites[0],"name":"Second"},
    ]);
    let (status, applied) = t.change("NEW", t.sites[0], ops, &day(0)).await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    assert_eq!(applied["status"], json!("APPLIED"));
    let request = uuid::Uuid::parse_str(applied["id"].as_str().unwrap()).unwrap();
    let mut created = Vec::new();
    for (index, name) in ["First", "Second"].into_iter().enumerate() {
        let command = console_orgchange_domain::projection::projected_unit_id(request, index);
        let (unit, attributes, receipt): (uuid::Uuid, serde_json::Value, serde_json::Value) =
            sqlx::query_as(
                "SELECT r.org_unit_id,r.attributes,c.receipt FROM org_unit_revisions r \
                JOIN ont_action_command_receipts c USING(org_id,command_id) \
                WHERE r.org_id=$1 AND r.command_id=$2",
            )
            .bind(t.org)
            .bind(command)
            .fetch_one(&t.owner)
            .await
            .unwrap();
        assert_eq!(attributes["name"], name);
        assert_eq!(receipt["target"], "organization.create_org_unit");
        assert_eq!(receipt["org_unit_id"], unit.to_string());
        created.push(unit);
    }
    assert_ne!(created[0], created[1]);
}
