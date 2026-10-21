#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BW-17 change requests, run as the runtime role `console_rt` (RLS armed,
//! column grants as in production).

mod support;

use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
// as_of runs a minute ahead: created_at is the database clock, not this host's.
use time::{Duration, OffsetDateTime};

use support::{create, decide, list, world};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_requester_never_decides_and_a_second_person_closes_once(pool: PgPool) {
    let w = world(&pool).await;
    let scope = w.admin(w.admin_a, w.branch_a);
    let request =
        w.hr.create_change_request(
            scope.clone(),
            create("SCOPE_ACTION", "EMPLOYEE", w.in_a, json!({})),
        )
        .await
        .unwrap();
    assert_eq!(request.status, "OPEN");

    // Self-decide: an HR person deciding their own request is 422.
    let own =
        w.hr.create_change_request(
            w.hr(w.hr_one),
            create("OTHER", "BRANCH", w.branch_a, json!({})),
        )
        .await
        .unwrap();
    assert!(own.review_required);
    let err =
        w.hr.decide_change_request(w.hr(w.hr_one), own.id, decide("APPLY"), support::SECOND)
            .await
            .unwrap_err();
    assert_eq!(
        (err.status, err.code),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            "change_request_self_decision"
        )
    );

    // A branch requester cannot apply at all (HR tier), but can withdraw its own.
    let err =
        w.hr.decide_change_request(scope.clone(), request.id, decide("APPLY"), support::SECOND)
            .await
            .unwrap_err();
    assert_eq!(err.status, StatusCode::FORBIDDEN);

    let applied =
        w.hr.decide_change_request(w.hr(w.hr_two), request.id, decide("APPLY"), support::SECOND)
            .await
            .unwrap();
    assert_eq!(
        (applied.status.as_str(), applied.decided_by),
        ("APPLIED", Some(w.hr_two))
    );
    let err =
        w.hr.decide_change_request(scope, request.id, decide("WITHDRAW"), support::SECOND)
            .await
            .unwrap_err();
    assert_eq!(
        (err.status, err.code),
        (StatusCode::CONFLICT, "change_request_closed")
    );

    let withdrawn =
        w.hr.decide_change_request(w.hr(w.hr_one), own.id, decide("WITHDRAW"), support::SECOND)
            .await
            .unwrap();
    assert_eq!(
        (withdrawn.status.as_str(), withdrawn.decided_by),
        ("WITHDRAWN", None)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_branch_requester_sees_only_its_own_requests_and_its_own_branch(pool: PgPool) {
    let w = world(&pool).await;
    let a = w.admin(w.admin_a, w.branch_a);
    let b_admin = w.admin(w.admin_b, w.branch_a);
    w.hr.create_change_request(
        a.clone(),
        create("SCOPE_ACTION", "EMPLOYEE", w.in_a, json!({})),
    )
    .await
    .unwrap();
    w.hr.create_change_request(
        b_admin.clone(),
        create("SCOPE_ACTION", "EMPLOYEE", w.in_a, json!({})),
    )
    .await
    .unwrap();
    // Another branch's employee reads as not found.
    let err =
        w.hr.create_change_request(
            a.clone(),
            create("IDENTITY_REVIEW", "EMPLOYEE", w.in_b, json!({})),
        )
        .await
        .unwrap_err();
    assert_eq!(err.status, StatusCode::NOT_FOUND);

    let mine =
        w.hr.list_change_requests(a.clone(), list(None))
            .await
            .unwrap();
    assert_eq!(mine.total, 1);
    assert!(mine.items.iter().all(|item| item.requested_by == w.admin_a));
    assert_eq!(
        w.hr.list_change_requests(a, list(Some("role")))
            .await
            .unwrap_err()
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        w.hr.list_change_requests(w.hr(w.hr_one), list(None))
            .await
            .unwrap()
            .total,
        2
    );
    assert_eq!(
        w.hr.list_change_requests(w.hr(w.hr_one), list(Some("role")))
            .await
            .unwrap()
            .total,
        2
    );
    assert_eq!(
        w.hr.list_change_requests(w.hr(w.hr_one), list(Some("me")))
            .await
            .unwrap()
            .total,
        0
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn profile_corrections_are_validated_and_hr_sees_them_in_its_inbox(pool: PgPool) {
    let w = world(&pool).await;
    let a = w.admin(w.admin_a, w.branch_a);
    let err =
        w.hr.create_change_request(
            a.clone(),
            create(
                "PROFILE_CORRECTION",
                "EMPLOYEE",
                w.in_a,
                json!({"changes": {"salary": 1}}),
            ),
        )
        .await
        .unwrap_err();
    assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
    let request =
        w.hr.create_change_request(
            a,
            create(
                "PROFILE_CORRECTION",
                "EMPLOYEE",
                w.in_a,
                json!({"changes": {"name": "새 이름"}}),
            ),
        )
        .await
        .unwrap();

    let inbox =
        w.hr.change_request_inbox_page(
            &w.hr(w.hr_one),
            OffsetDateTime::now_utc() + Duration::minutes(1),
            None,
            50,
        )
        .await
        .unwrap();
    assert_eq!((inbox.total, inbox.items[0].id), (1, request.id));
    let none =
        w.hr.change_request_inbox_page(
            &w.admin(w.admin_b, w.branch_a),
            OffsetDateTime::now_utc() + Duration::minutes(1),
            None,
            50,
        )
        .await
        .unwrap();
    assert_eq!(none.total, 0);

    let declined =
        w.hr.decide_change_request(
            w.hr(w.hr_one),
            request.id,
            decide("DECLINE"),
            support::SECOND,
        )
        .await
        .unwrap();
    assert_eq!(declined.status, "DECLINED");
}
