//! E-S3b: SETUP records (decisions #26) and 전근 through the employment assignment.

use serde_json::json;
use sqlx::PgPool;
use time::Duration;

use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn leave_and_transfers_are_setup_records_in_setup(pool: PgPool) {
    // decisions #26: migrating in must not dead-end on 휴직 or 전근.
    let f = fixture(pool, false).await;
    let leave = event(
        "LEAVE_OF_ABSENCE",
        &day(-3),
        json!({"leave_type": "PERSONAL", "expected_return_date": day(60)}),
    );
    let on_leave = f.record(leave).await.unwrap();
    assert_eq!(on_leave["to_status"], json!("ON_LEAVE"));
    assert_eq!(f.setup_records().await, 1, "audited as a setup record");
    // Undoable in SETUP: the rescind restores the head.
    f.rescind(&on_leave).await;
    let transfer = event("TRANSFER", &day(0), json!({"to_org_unit": "다른 팀"}));
    f.record(transfer).await.unwrap();
    assert_eq!(f.setup_records().await, 2);
    // Setting up the people themselves was never held: a PROMOTE records.
    let promote = event("PROMOTE", &day(0), json!({"to_position": "대리"}));
    f.record(promote).await.unwrap();
    assert_eq!(
        f.setup_records().await,
        2,
        "only phase-bound acts are badged"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_transfer_to_another_workplace_splits_the_assignment_until_rescinded(pool: PgPool) {
    let f = fixture(pool, true).await;
    let (entity, w) = f.entity(2).await;
    f.place(entity, w[0]).await;
    let on = day(-3);
    let moved = f
        .record(event("TRANSFER", &on, json!({"to_workplace_id": w[1]})))
        .await
        .unwrap();
    assert_eq!(moved["to_workplace_id"], json!(w[1]));
    let cases =
        f.hr.employee_lifecycle_cases(f.principal.clone(), f.employee)
            .await
            .unwrap();
    let case = cases
        .iter()
        .find(|case| {
            Some(case.trigger_id.unwrap().to_string()) == moved["id"].as_str().map(str::to_owned)
        })
        .unwrap();
    let filings: Vec<_> = case
        .items
        .iter()
        .filter(|item| item.kind == "FIL")
        .collect();
    assert!(
        !filings.is_empty(),
        "a workplace change opens register-owned statutory work"
    );
    for item in filings {
        assert!(item.filing_obligation_id.is_some());
        assert!(item.insurer.is_some());
        assert_eq!(item.filing_kind.as_deref(), Some("CHANGE"));
        assert_eq!(item.due_disposition, "UNKNOWN");
        assert!(item.due_date.is_none());
        assert_eq!(item.basis["legal_review_required"], true);
    }
    assert_eq!(
        f.live().await,
        [
            (
                HIRE.to_owned(),
                Some(on.clone()),
                Some(w[0]),
                "HIRE".to_owned()
            ),
            (on.clone(), None, Some(w[1]), "TRANSFER".to_owned()),
        ]
    );
    // Asking for the 사업장 they are at, with no unit change, changes nothing.
    let again = event("TRANSFER", &day(-1), json!({"to_workplace_id": w[1]}));
    assert_eq!(
        f.record(again).await.unwrap_err(),
        (422, "lifecycle_noop".to_owned())
    );
    f.rescind(&moved).await;
    assert_eq!(
        f.live().await,
        [(HIRE.to_owned(), None, Some(w[0]), "HIRE".to_owned())]
    );
    // Moved again and rescinded again: still one row at the first 사업장.
    let again = f
        .record(event("TRANSFER", &on, json!({"to_workplace_id": w[1]})))
        .await
        .unwrap();
    assert_eq!(f.live().await.len(), 2);
    f.rescind(&again).await;
    assert_eq!(
        f.live().await,
        [(HIRE.to_owned(), None, Some(w[0]), "HIRE".to_owned())]
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_move_on_the_day_the_placement_starts_is_a_correction(pool: PgPool) {
    let f = fixture(pool, true).await;
    let (entity, w) = f.entity(2).await;
    let on = day(-5);
    f.place_from(entity, w[0], &on).await;
    let moved = event("TRANSFER", &on, json!({"to_workplace_id": w[1]}));
    assert_eq!(
        f.record(moved).await.unwrap_err(),
        (409, "assignment_starts_on_move_date".to_owned())
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_unit_at_another_workplace_takes_the_employee_there_on_its_date(pool: PgPool) {
    let f = fixture(pool, true).await;
    let (entity, w) = f.entity(2).await;
    f.place(entity, w[0]).await;
    let unit = f.unit_at(entity, w[1]).await;
    let on = day(10);
    let scheduled = f
        .record(event("TRANSFER", &on, json!({"to_org_unit_id": unit})))
        .await
        .unwrap();
    assert_eq!(scheduled["state"], "SCHEDULED");
    assert_eq!(scheduled["to_workplace_id"], json!(w[1]));
    assert_eq!(f.live().await.len(), 1, "nothing moves before its date");
    // A named 사업장 that is not the unit's is refused.
    let mismatch = event(
        "TRANSFER",
        &day(11),
        json!({"to_org_unit_id": unit, "to_workplace_id": w[0]}),
    );
    assert_eq!(
        f.record(mismatch).await.unwrap_err(),
        (422, "org_unit_at_other_workplace".to_owned())
    );
    let target = today() + Duration::days(10);
    assert_eq!(f.hr.apply_due(target).await.unwrap(), 1);
    assert_eq!(
        f.live().await,
        [
            (
                HIRE.to_owned(),
                Some(on.clone()),
                Some(w[0]),
                "HIRE".to_owned()
            ),
            (on.clone(), None, Some(w[1]), "TRANSFER".to_owned()),
        ]
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn another_entity_is_a_group_transfer_and_an_unplaced_employee_is_refused(pool: PgPool) {
    let f = fixture(pool, true).await;
    let (entity, w) = f.entity(1).await;
    let (_, other) = f.entity(1).await;
    let named = event("TRANSFER", &day(-1), json!({"to_workplace_id": w[0]}));
    assert_eq!(
        f.record(named).await.unwrap_err(),
        (409, "employee_unassigned".to_owned())
    );
    f.place(entity, w[0]).await;
    let elsewhere = event("TRANSFER", &day(-1), json!({"to_workplace_id": other[0]}));
    assert_eq!(
        f.record(elsewhere).await.unwrap_err(),
        (422, "transfer_cross_entity".to_owned())
    );
    let renamed = event("TRANSFER", &day(-1), json!({"to_company": "다른 회사"}));
    assert_eq!(
        f.record(renamed).await.unwrap_err(),
        (409, "entity_change_needs_group_transfer".to_owned())
    );
    assert_eq!(f.live().await.len(), 1);
}
