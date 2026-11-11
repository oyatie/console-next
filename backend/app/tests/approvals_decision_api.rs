// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The approval document's decision: offered on the read exactly where the
//! source command accepts it, and decided through that one command.
#[path = "support/approvals.rs"]
mod fixtures;
#[path = "../../test-support/org_change_fixtures.rs"]
mod grants;
#[path = "support/http.rs"]
mod http;
#[path = "../../test-support/person_fixtures.rs"]
mod people;
use ::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

/// The first step's stored decision: (decision, reason_code, memo).
async fn first_step(pool: &PgPool, id: Uuid) -> (String, Option<String>, Option<String>) {
    sqlx::query_as(
        "SELECT decision, reason_code, memo FROM org_change_approval_steps \
         WHERE request_id=$1 AND step_order=1",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .unwrap()
}

fn decision(document: &Value, decision: &str, extra: Value) -> Value {
    let mut body = json!({
        "decision": decision,
        "seen_fingerprint": document["fingerprint"],
        "opinion": "",
    });
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    body
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_offered_approval_is_decided_once_and_the_route_moves_on(pool: PgPool) {
    let (org, maker, checker) = fixtures::setup(&pool).await;
    let id = fixtures::document(&pool, org, maker, "OC-2026-0001").await;
    let ctx = fixtures::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    let uri = format!("/api/v1/approvals/org_change:{id}");
    let (status, first) = ctx.call("GET", &uri, None).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(
        first["my_actions"],
        json!({"kind": "approve", "reject": {"consequence": "request_ends", "reason_domain": "org_change_reject"}}),
        "return is not offered: the source has no such transition"
    );
    assert_eq!(first["consequence"], "next_step", "another step follows");
    assert!(first["opinion_max"].as_u64().unwrap() > 0);

    let body = decision(&first, "APPROVE", json!({"opinion": "검토했습니다"}));
    let decide = format!("{uri}/decision");
    let (status, receipt) = ctx.call("POST", &decide, Some(body.clone())).await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    assert_eq!(
        receipt,
        json!({"decision": "APPROVED", "status": "IN_APPROVAL"})
    );
    // The same intent again is the platform's "already applied", never a second decision.
    let (status, replay) = ctx.retry("POST", &decide, Some(body)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{replay}");
    assert_eq!(replay["error"]["code"], "command_applied");
    assert_eq!(
        first_step(&pool, id).await,
        ("APPROVED".into(), None, Some("검토했습니다".into()))
    );

    let (status, after) = ctx.call("GET", &uri, None).await;
    assert_eq!(status, StatusCode::OK, "{after}");
    assert_eq!(after["route"][0]["state"], "done");
    assert_eq!(after["route"][1]["state"], "current");
    assert_eq!(
        after["my_actions"],
        json!({"kind": "none"}),
        "one person decides one step"
    );
    assert_ne!(after["fingerprint"], first["fingerprint"]);
    // The person who decided the first step is refused the second, as the read said.
    let (status, body) = ctx
        .call(
            "POST",
            &decide,
            Some(decision(&after, "APPROVE", json!({}))),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "approval_decision_unavailable");

    // A third person takes the last step, and the document is approved.
    let closer = http::add_user(&pool, org, &["EXECUTIVE"]).await;
    people::bind_user_to_distinct_person(&pool, closer).await;
    grants::grant_org_approve(&pool, closer).await;
    let last = fixtures::ctx(&pool, org, closer, &["EXECUTIVE"], None).await;
    let (_, seen) = last.call("GET", &uri, None).await;
    assert_eq!(seen["my_actions"]["kind"], "approve", "{seen}");
    assert_eq!(seen["consequence"], "final");
    let (status, receipt) = last
        .call("POST", &decide, Some(decision(&seen, "APPROVE", json!({}))))
        .await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    assert_eq!(
        receipt,
        json!({"decision": "APPROVED", "status": "APPROVED"})
    );
}

/// The read's offer and the decision's answer come from the same rules: an
/// approver whose authority is a grant, not one of the approving roles, gets
/// the same yes or no from both.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_read_and_the_decision_agree_for_an_approver_by_grant_alone(pool: PgPool) {
    let (org, maker, _) = fixtures::setup(&pool).await;
    let id = fixtures::document(&pool, org, maker, "OC-2026-0005").await;
    let uri = format!("/api/v1/approvals/org_change:{id}");
    let granted = http::add_user(&pool, org, &["MEMBER"]).await;
    people::bind_user_to_distinct_person(&pool, granted).await;
    grants::grant_org_approve(&pool, granted).await;
    let ctx = fixtures::ctx(&pool, org, granted, &["MEMBER"], None).await;
    let (read_status, document) = ctx.call("GET", &uri, None).await;
    let offered = read_status == StatusCode::OK && document["my_actions"]["kind"] == "approve";
    let (status, body) = ctx
        .call(
            "POST",
            &format!("{uri}/decision"),
            Some(decision(&document, "APPROVE", json!({}))),
        )
        .await;
    assert_eq!(
        status == StatusCode::OK,
        offered,
        "read {read_status} {document} / decision {status} {body}"
    );
    assert_eq!(first_step(&pool, id).await.0 == "APPROVED", offered);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_last_step_says_so_and_a_rejection_keeps_its_reason_and_both_texts(pool: PgPool) {
    let (org, maker, checker) = fixtures::setup(&pool).await;
    let id = fixtures::document(&pool, org, maker, "OC-2026-0002").await;
    // One step left: an approval here is the final one.
    sqlx::query("DELETE FROM org_change_approval_steps WHERE request_id=$1 AND step_order=2")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let ctx = fixtures::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    let uri = format!("/api/v1/approvals/org_change:{id}");
    let decide = format!("{uri}/decision");
    let (_, first) = ctx.call("GET", &uri, None).await;
    assert_eq!(first["consequence"], "final");

    // A rejection names its reason; a reason that needs a note has one.
    for (extra, field) in [
        (json!({}), "reason_code"),
        (json!({"reason_code": "NOT_A_CODE"}), "reason_code"),
        (json!({"reason_code": "OTHER"}), "note"),
    ] {
        let (status, body) = ctx
            .call(
                "POST",
                &decide,
                Some(decision(&first, "REJECT", extra.clone())),
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{extra}: {body}");
        assert!(body.to_string().contains(field), "{extra}: {body}");
    }
    assert_eq!(first_step(&pool, id).await.0, "PENDING");

    let body = decision(
        &first,
        "REJECT",
        json!({"opinion": "다음 분기에 다시 올려 주십시오", "reason_code": "INSUFFICIENT_BASIS", "note": "근거 자료 없음"}),
    );
    let (status, receipt) = ctx.call("POST", &decide, Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    assert_eq!(
        receipt,
        json!({"decision": "REJECTED", "status": "REJECTED"})
    );
    assert_eq!(
        first_step(&pool, id).await,
        (
            "REJECTED".into(),
            Some("INSUFFICIENT_BASIS".into()),
            Some("근거 자료 없음\n\n다음 분기에 다시 올려 주십시오".into())
        ),
        "the reason's note and the opinion are both kept"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_changed_document_is_refused_and_nothing_is_decided(pool: PgPool) {
    let (org, maker, checker) = fixtures::setup(&pool).await;
    let id = fixtures::document(&pool, org, maker, "OC-2026-0003").await;
    let ctx = fixtures::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    let uri = format!("/api/v1/approvals/org_change:{id}");
    let (_, seen) = ctx.call("GET", &uri, None).await;
    sqlx::query("UPDATE org_change_requests SET reason='수정된 사유' WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = ctx
        .call(
            "POST",
            &format!("{uri}/decision"),
            Some(decision(&seen, "APPROVE", json!({}))),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "approval_document_changed");
    assert_eq!(first_step(&pool, id).await.0, "PENDING");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn where_the_read_offers_nothing_the_decision_is_refused(pool: PgPool) {
    let (org, maker, checker) = fixtures::setup(&pool).await;
    let id = fixtures::document(&pool, org, maker, "OC-2026-0004").await;
    let uri = format!("/api/v1/approvals/org_change:{id}");
    let decide = format!("{uri}/decision");

    // The drafter reads the document and is offered no decision.
    let drafter = fixtures::ctx(&pool, org, maker, &["SUPER_ADMIN"], None).await;
    let (status, own) = drafter.call("GET", &uri, None).await;
    assert_eq!(status, StatusCode::OK, "{own}");
    assert_eq!(own["my_actions"], json!({"kind": "none"}));
    let (status, body) = drafter
        .call("POST", &decide, Some(decision(&own, "APPROVE", json!({}))))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "approval_decision_unavailable");

    // A member with no approval authority cannot see it; the decision is the same 404 as the read.
    let outsider = http::add_user(&pool, org, &["MEMBER"]).await;
    let hidden = fixtures::ctx(&pool, org, outsider, &["MEMBER"], None).await;
    let (read_status, read_body) = hidden.call("GET", &uri, None).await;
    let (status, body) = hidden
        .call("POST", &decide, Some(decision(&own, "APPROVE", json!({}))))
        .await;
    assert_eq!(
        (read_status, status),
        (StatusCode::NOT_FOUND, StatusCode::NOT_FOUND),
        "{body}"
    );
    for field in ["code", "message"] {
        assert_eq!(body["error"][field], read_body["error"][field]);
    }

    // 보완 요청 is not a decision this document takes.
    let ctx = fixtures::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    let (_, seen) = ctx.call("GET", &uri, None).await;
    let returned = decision(&seen, "RETURN", json!({"reason_code": "NEEDS_SUPPLEMENT"}));
    let (status, body) = ctx.call("POST", &decide, Some(returned)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(first_step(&pool, id).await.0, "PENDING");

    // A document that is no longer in approval offers nothing either.
    sqlx::query("UPDATE org_change_requests SET status='CANCELLED' WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let (read_status, closed) = ctx.call("GET", &uri, None).await;
    let (status, body) = ctx
        .call("POST", &decide, Some(decision(&seen, "APPROVE", json!({}))))
        .await;
    if read_status == StatusCode::OK {
        assert_eq!(closed["my_actions"], json!({"kind": "none"}));
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
    } else {
        // No box holds it for this viewer any more: the decision is the read's 404.
        assert_eq!(
            (read_status, status),
            (StatusCode::NOT_FOUND, StatusCode::NOT_FOUND),
            "{body}"
        );
    }
    assert_eq!(first_step(&pool, id).await.0, "PENDING");
}
