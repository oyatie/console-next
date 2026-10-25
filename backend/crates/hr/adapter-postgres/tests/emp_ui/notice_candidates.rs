// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

fn candidate_page(limit: i64, cursor: Option<String>) -> AppointmentNoticeListQuery {
    serde_json::from_value(json!({"limit": limit, "cursor": cursor})).unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn notice_candidates_exclude_noticed_cancelled_and_voided_events(pool: PgPool) {
    let f = fixture(pool, true).await;
    let (_, applied) = batch(&f, 4, "2026-09-01").await;
    issue(&f, &f.ops, notice(json!({"event_ids": [applied[0]]})))
        .await
        .unwrap();
    let employee: Uuid =
        sqlx::query_scalar("SELECT employee_id FROM employee_lifecycle_events WHERE id = $1")
            .bind(applied[1])
            .fetch_one(&f.owner)
            .await
            .unwrap();
    f.hr.rescind_lifecycle_event(
        f.ops.clone(),
        employee,
        applied[1],
        serde_json::from_value(json!({"reason_code": "INPUT_ERROR", "confirm_cascades": true}))
            .unwrap(),
    )
    .await
    .unwrap();
    let (_, scheduled) = batch(&f, 1, "2027-03-01").await;
    let (cancelled_batch, _) = batch(&f, 1, "2027-03-02").await;
    f.hr.rescind_lifecycle_batch(
        f.ops.clone(),
        cancelled_batch,
        serde_json::from_value(json!({"reason_code": "PLAN_WITHDRAWN", "confirm_cascades": true}))
            .unwrap(),
    )
    .await
    .unwrap();
    let candidates =
        f.hr.appointment_notice_candidates(f.ops.clone(), candidate_page(50, None))
            .await
            .unwrap();
    assert!(candidates.next_cursor.is_none());
    let ids: std::collections::BTreeSet<Uuid> =
        candidates.items.iter().map(|c| c.event.id).collect();
    assert_eq!(ids, [applied[2], applied[3], scheduled[0]].into());
    assert!(candidates.items.iter().all(|c| c.name == "한결"
        && c.employee_id == c.event.employee_id
        && c.employee_number.is_none()));
    assert!(candidates.items.iter().any(|c| c.event.state == "APPLIED"));
    assert!(
        candidates
            .items
            .iter()
            .any(|c| c.event.state == "SCHEDULED")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn notice_candidates_page_without_repeating_or_skipping_events(pool: PgPool) {
    let f = fixture(pool, true).await;
    let (_, expected) = batch(&f, 3, "2026-09-01").await;
    let first =
        f.hr.appointment_notice_candidates(f.ops.clone(), candidate_page(2, None))
            .await
            .unwrap();
    assert_eq!(first.items.len(), 2);
    assert!(first.next_cursor.is_some());
    let _ = batch(&f, 1, "2026-09-02").await;
    let second =
        f.hr.appointment_notice_candidates(f.ops.clone(), candidate_page(2, first.next_cursor))
            .await
            .unwrap();
    assert_eq!(second.items.len(), 1);
    assert!(second.next_cursor.is_none());
    let ids: std::collections::BTreeSet<Uuid> = first
        .items
        .iter()
        .chain(&second.items)
        .map(|c| c.event.id)
        .collect();
    assert_eq!(ids, expected.into_iter().collect());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn notice_candidates_require_org_wide_manage_and_stay_in_the_tenant(pool: PgPool) {
    let f = fixture(pool.clone(), true).await;
    let (_, own) = batch(&f, 1, "2026-09-01").await;
    let other = fixture(pool, true).await;
    let _ = batch(&other, 1, "2026-09-01").await;
    let candidates =
        f.hr.appointment_notice_candidates(f.ops.clone(), candidate_page(50, None))
            .await
            .unwrap();
    assert_eq!(candidates.items.len(), 1);
    assert_eq!(candidates.items[0].event.id, own[0]);
    for principal in [
        f.granted(Feature::EmployeeDirectoryRead, BranchScope::All)
            .await,
        f.granted(Feature::EmployeeDirectoryManage, crate::one_branch())
            .await,
    ] {
        let denied = f
            .hr
            .appointment_notice_candidates(principal, candidate_page(50, Some("invalid".into())))
            .await
            .unwrap_err();
        assert_eq!(status(&denied).0, 403);
    }
}
