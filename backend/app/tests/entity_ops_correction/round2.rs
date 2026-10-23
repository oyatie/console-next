// SPDX-License-Identifier: LicenseRef-Proprietary
use super::maturity::{get, request};
use super::*;
use console_kernel_core::{AccessScope, AccessScopeLevel, ScopeNodeId};

const REGISTER: &str = "/api/v1/entity-identifier-corrections";

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn register_reads_refuse_members_and_branch_scoped_holders(owner: PgPool) {
    let mut s = setup::setup(&owner).await;
    let (_, receipt, _) = request(&owner, &mut s).await;
    let id = receipt["exception_id"].as_str().unwrap();
    let org: Uuid = sqlx::query_scalar("SELECT org_id FROM users WHERE id=$1")
        .bind(s.approver.id)
        .fetch_one(&owner)
        .await
        .unwrap();
    let scoped = period_unlock_support::session_token_in_scope(
        &owner,
        &s.issuer,
        OrgId::from_uuid(org),
        s.approver.id,
        "SUPER_ADMIN",
        Some(AccessScope::new(
            AccessScopeLevel::Branch,
            ScopeNodeId::from_uuid(Uuid::new_v4()),
        )),
    )
    .await;
    for token in [&s.member.token, &scoped] {
        for uri in [
            REGISTER.to_owned(),
            format!("{REGISTER}/{id}"),
            format!("{REGISTER}?awaiting=me"),
        ] {
            let (status, body) = get(&s, &uri, token).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{uri}: {body}");
            assert_eq!(body["error"]["code"], "forbidden");
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn my_queue_reuses_decision_eligibility_and_finds_work_after_non_actionable_rows(
    owner: PgPool,
) {
    let mut s = setup::setup(&owner).await;
    let (_, receipt, _) = request(&owner, &mut s).await;
    let id: Uuid = receipt["exception_id"].as_str().unwrap().parse().unwrap();
    // More than one register page of settled work must not hide the pending decision.
    let org: Uuid = sqlx::query_scalar("SELECT org_id FROM users WHERE id=$1")
        .bind(s.ops.id)
        .fetch_one(&owner)
        .await
        .unwrap();
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO governed_exceptions (org_id,rule_code,risk,subject_type,subject_id,reason_code,fingerprint,affected_periods,settings_snapshot,requested_by,status,fallback_kind,expires_at,decided_by,decided_at,decision_reason_code) SELECT org_id,rule_code,risk,subject_type,subject_id,reason_code,fingerprint,affected_periods,settings_snapshot,requested_by,'DECLINED',fallback_kind,expires_at,$2,now(),'DOCUMENT_MISMATCH' FROM governed_exceptions CROSS JOIN generate_series(1,55) WHERE id=$1")
        .bind(id).bind(s.approver.id).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    for token in [&s.ops.token, &s.contributor.token] {
        let (status, body) = get(&s, &format!("{REGISTER}?awaiting=me"), token).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["items"], json!([]), "{body}");
    }
    let (status, body) = get(&s, &format!("{REGISTER}?awaiting=me"), &s.approver.token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["items"].as_array().unwrap().len(), 1, "{body}");
    assert_eq!(body["items"][0]["id"], json!(id));
    assert_eq!(body["items"][0]["can_decide"], true);
    assert_eq!(body["next_offset"], Value::Null);
    let proof = step_up_with_binding(
        &owner,
        &s.svc,
        &mut s.approver,
        MobilePasskeyStepUpBinding::bound(
            MobileStepUpActionKind::ExceptionDecide,
            id,
            receipt["payload_hash"].as_str().unwrap().to_owned(),
        ),
    )
    .await;
    let (status, body) = send(
        &s.service,
        &format!("/api/v1/governed-exceptions/{id}/decide"),
        &s.approver.token,
        Some(&key()),
        json!({"decision":"APPROVE", "reason_code":"SECOND_PERSON_VERIFIED", "step_up":proof}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, body) = get(&s, &format!("{REGISTER}?awaiting=me"), &s.ops.token).await;
    assert_eq!(body["items"].as_array().unwrap().len(), 1, "{body}");
    assert_eq!(body["items"][0]["can_apply"], true);
    let (_, body) = get(&s, &format!("{REGISTER}?awaiting=me"), &s.approver.token).await;
    assert_eq!(body["items"], json!([]));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn expired_pending_request_does_not_block_a_new_correction(owner: PgPool) {
    let mut s = setup::setup(&owner).await;
    let (status, receipt, _) = request(&owner, &mut s).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{receipt}");
    let id: Uuid = receipt["exception_id"].as_str().unwrap().parse().unwrap();
    let org: Uuid = sqlx::query_scalar("SELECT org_id FROM users WHERE id=$1")
        .bind(s.ops.id)
        .fetch_one(&owner)
        .await
        .unwrap();
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO governed_exceptions (org_id,rule_code,risk,subject_type,subject_id,reason_code,fingerprint,affected_periods,settings_snapshot,requested_by,status,fallback_kind,expires_at,created_at) SELECT org_id,rule_code,risk,subject_type,subject_id,reason_code,fingerprint,affected_periods,settings_snapshot,requested_by,status,fallback_kind,now()-interval '1 day',now()-interval '30 days' FROM governed_exceptions WHERE id=$1")
        .bind(id).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let (status, body) = send(
        &s.service,
        &format!("/api/v1/governed-exceptions/{id}/decide"),
        &s.approver.token,
        Some(&key()),
        json!({"decision":"DECLINE", "reason_code":"DOCUMENT_MISMATCH"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body, _) = request(&owner, &mut s).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    assert_ne!(body["exception_id"], receipt["exception_id"]);
    let (_, queue) = get(&s, &format!("{REGISTER}?awaiting=me"), &s.approver.token).await;
    assert_eq!(queue["items"].as_array().unwrap().len(), 1, "{queue}");
    assert_eq!(queue["items"][0]["id"], body["exception_id"]);
}
