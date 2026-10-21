#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BW-17 answer kinds (governance S7 소명 요청, S5 policy question): the named
//! assignee answers, even without employee-directory access. Runs as
//! `console_rt` (RLS armed, column grants as in production).

mod support;

use std::collections::BTreeSet;

use console_hr_adapter_postgres::requests::{CreateChangeRequest, DecideChangeRequest};
use console_kernel_core::{BranchId, BranchScope, OrgId, UserId};
use console_platform_authz::{Principal, Role};
use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use support::{list, world};

fn explanation(subject: Uuid, assignee: Uuid) -> CreateChangeRequest {
    serde_json::from_value(json!({
        "kind": "ACCESS_EXPLANATION", "subject_type": "USER_ACCOUNT", "subject_id": subject,
        "payload": { "review_item": "after-hours bulk read" },
        "reason_code": "AFTER_HOURS_ACCESS", "assignee_user_id": assignee
    }))
    .unwrap()
}

fn answer(note: Option<&str>) -> DecideChangeRequest {
    serde_json::from_value(
        json!({ "decision": "APPLY", "reason_code": "BUSINESS_NEED", "note": note }),
    )
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_named_handler_answers_its_access_explanation_without_directory_access(pool: PgPool) {
    let w = world(&pool).await;
    // The 취급자 holds no employee-directory capability at all.
    let handler = Principal::new(
        UserId::from_uuid(w.admin_a),
        OrgId::from_uuid(w.org),
        BTreeSet::from([Role::Mechanic]),
        BranchScope::Branches(BTreeSet::from([BranchId::from_uuid(w.branch_a)])),
    );
    let as_of = OffsetDateTime::now_utc() + Duration::minutes(1);

    // Only an org-wide access-log reader asks; the assignee is the subject.
    let err =
        w.hr.create_change_request(
            w.admin(w.admin_b, w.branch_a),
            explanation(w.admin_a, w.admin_a),
        )
        .await
        .unwrap_err();
    assert_eq!(err.status, StatusCode::FORBIDDEN);
    let err =
        w.hr.create_change_request(w.hr(w.hr_one), explanation(w.admin_a, w.hr_two))
            .await
            .unwrap_err();
    assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
    let asked =
        w.hr.create_change_request(w.hr(w.hr_one), explanation(w.admin_a, w.admin_a))
            .await
            .unwrap();

    // It reaches the handler's list and 내 차례, and nobody else's but HR's list.
    let mine =
        w.hr.list_change_requests(handler.clone(), list(Some("me")))
            .await
            .unwrap();
    assert_eq!((mine.total, mine.items[0].id), (1, asked.id));
    let inbox =
        w.hr.change_request_inbox_page(&handler, as_of, None, 50)
            .await
            .unwrap();
    assert_eq!((inbox.total, inbox.items[0].id), (1, asked.id));
    let bystander = w.admin(w.admin_b, w.branch_a);
    let none =
        w.hr.change_request_inbox_page(&bystander, as_of, None, 50)
            .await
            .unwrap();
    assert_eq!(none.total, 0);
    assert_eq!(
        w.hr.list_change_requests(bystander.clone(), list(None))
            .await
            .unwrap()
            .total,
        0
    );
    let err =
        w.hr.decide_change_request(bystander, asked.id, answer(Some("x")), support::SECOND)
            .await
            .unwrap_err();
    assert_eq!(err.status, StatusCode::NOT_FOUND);

    // HR is not the named person; the answer needs a note.
    let err =
        w.hr.decide_change_request(w.hr(w.hr_two), asked.id, answer(Some("x")), support::SECOND)
            .await
            .unwrap_err();
    assert_eq!(
        (err.status, err.code),
        (StatusCode::FORBIDDEN, "change_request_not_assignee")
    );
    let err =
        w.hr.decide_change_request(handler.clone(), asked.id, answer(None), support::SECOND)
            .await
            .unwrap_err();
    assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
    let answered =
        w.hr.decide_change_request(
            handler.clone(),
            asked.id,
            answer(Some("월말 정산 대사 업무")),
            support::SECOND,
        )
        .await
        .unwrap();
    assert_eq!(
        (answered.status.as_str(), answered.decided_by),
        ("APPLIED", Some(w.admin_a))
    );
    assert_eq!(
        w.hr.list_change_requests(w.hr(w.hr_one), list(None))
            .await
            .unwrap()
            .items[0]
            .decision_note
            .as_deref(),
        Some("월말 정산 대사 업무")
    );
    // HR's own 기다리는 중: only what it filed.
    let filed =
        |requester: Option<&str>| -> console_hr_adapter_postgres::requests::ChangeRequestListQuery {
            serde_json::from_value(json!({ "requester": requester })).unwrap()
        };
    let hr_two_filed =
        w.hr.list_change_requests(w.hr(w.hr_two), filed(Some("me")))
            .await
            .unwrap();
    assert_eq!(hr_two_filed.total, 0);
    let hr_one_filed =
        w.hr.list_change_requests(w.hr(w.hr_one), filed(Some("me")))
            .await
            .unwrap();
    assert_eq!(hr_one_filed.total, 1);
    // Outside HR a named person still cannot apply a correction kind.
    let scope_action =
        w.hr.create_change_request(
            w.hr(w.hr_one),
            serde_json::from_value(json!({
                "kind": "SCOPE_ACTION", "subject_type": "EMPLOYEE", "subject_id": w.in_a,
                "reason_code": "DATA_ENTRY_ERROR", "assignee_user_id": w.admin_a
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let err =
        w.hr.decide_change_request(handler, scope_action.id, answer(Some("x")), support::SECOND)
            .await
            .unwrap_err();
    assert_eq!(err.status, StatusCode::FORBIDDEN);
}
