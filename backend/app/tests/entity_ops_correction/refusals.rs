// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_identity_adapter_postgres::second_person::{
    SecondPersonQuery, second_person_fact_in_tx,
};
use console_kernel_core::{AccessScope, AccessScopeLevel, ScopeNodeId, UserId};
use console_platform_authz::Feature;

async fn pending(owner: &PgPool) -> (setup::Setup, Uuid, MobilePasskeyStepUpBinding) {
    let mut s = setup::setup(owner).await;
    let line = format!("ENTITY_IDENTIFIER_CORRECTION\ncrn\n{FIXED}\n{}", s.doc);
    let proof = step_up_as(
        owner,
        &s.svc,
        &mut s.ops,
        MobileStepUpActionKind::ExceptionDecide,
        s.entity,
        &line,
    )
    .await;
    let (status, receipt) = send(
        &s.service,
        &format!("/api/v1/legal-entities/{}/identifier-corrections", s.entity),
        &s.ops.token,
        Some(&key()),
        json!({"field":"crn", "value":FIXED, "document_id":s.doc, "reason_code":"REGISTRY_DIFFERS", "step_up":proof}),
    ).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{receipt}");
    let id = receipt["exception_id"].as_str().unwrap().parse().unwrap();
    let binding = MobilePasskeyStepUpBinding::bound(
        MobileStepUpActionKind::ExceptionDecide,
        id,
        receipt["payload_hash"].as_str().unwrap().to_owned(),
    );
    (s, id, binding)
}

async fn eligible(owner: &PgPool, id: Uuid, user: Uuid) -> bool {
    let (org, requester, created_at): (Uuid, Uuid, time::OffsetDateTime) = sqlx::query_as(
        "SELECT org_id, requested_by, created_at FROM governed_exceptions WHERE id=$1",
    )
    .bind(id)
    .fetch_one(owner)
    .await
    .unwrap();
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let fact = second_person_fact_in_tx(
        &mut tx,
        &SecondPersonQuery {
            org: OrgId::from_uuid(org),
            feature: Feature::OrgChangeApply,
            branch: None,
            requester: UserId::from_uuid(requester),
            excluded: vec![],
            case_created_at: created_at,
            min_grant_age_days: 7,
        },
    )
    .await
    .unwrap();
    tx.rollback().await.unwrap();
    fact.eligible.contains(&user)
}

async fn unchanged(owner: &PgPool, id: Uuid) {
    let (status, decided_by): (String, Option<Uuid>) =
        sqlx::query_as("SELECT status, decided_by FROM governed_exceptions WHERE id=$1")
            .bind(id)
            .fetch_one(owner)
            .await
            .unwrap();
    assert_eq!(status, "PENDING");
    assert_eq!(decided_by, None);
    assert_eq!(count(owner, "SELECT COUNT(*) FROM audit_events WHERE action='exception.decide' AND target_id=$1::text", id).await, 0);
}

async fn copy_pending(
    owner: &PgPool,
    source: Uuid,
    rule: &str,
    created_at: time::OffsetDateTime,
) -> (Uuid, MobilePasskeyStepUpBinding) {
    let mut tx = owner.begin().await.unwrap();
    let org: Uuid = sqlx::query_scalar("SELECT org_id FROM governed_exceptions WHERE id=$1")
        .bind(source)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    // Insert a historical fixture: request snapshots are immutable after creation.
    let (id, fingerprint): (Uuid, String) = sqlx::query_as(
        "INSERT INTO governed_exceptions (org_id, rule_code, risk, subject_type, subject_id, \
         reason_code, fingerprint, affected_periods, settings_snapshot, requested_by, \
         step_up_assertion_id, status, fallback_kind, expires_at, created_at) \
         SELECT org_id, $2, risk, subject_type, subject_id, reason_code, fingerprint, affected_periods, \
         settings_snapshot, requested_by, step_up_assertion_id, status, fallback_kind, expires_at, $3 \
         FROM governed_exceptions WHERE id=$1 RETURNING id, fingerprint",
    ).bind(source).bind(rule).bind(created_at).fetch_one(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    (
        id,
        MobilePasskeyStepUpBinding::bound(MobileStepUpActionKind::ExceptionDecide, id, fingerprint),
    )
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn newly_granted_holder_cannot_approve_or_decline(owner: PgPool) {
    let (s, id, binding) = pending(&owner).await;
    let org: Uuid = sqlx::query_scalar("SELECT org_id FROM users WHERE id=$1")
        .bind(s.ops.id)
        .fetch_one(&owner)
        .await
        .unwrap();
    let mut newcomer = admin_in(
        &owner,
        &s.svc,
        &s.issuer,
        OrgId::from_uuid(org),
        "새 결재자",
    )
    .await;
    sqlx::query("UPDATE authz_grant_ledger SET occurred_at=now() WHERE user_id=$1")
        .bind(newcomer.id)
        .execute(&owner)
        .await
        .unwrap();
    assert!(!eligible(&owner, id, newcomer.id).await);
    let proof = step_up_with_binding(&owner, &s.svc, &mut newcomer, binding).await;
    for decision in ["APPROVE", "DECLINE"] {
        let (status, refused) = send(
            &s.service,
            &format!("/api/v1/governed-exceptions/{id}/decide"),
            &newcomer.token,
            Some(&key()),
            json!({"decision":decision, "reason_code":"SECOND_PERSON_VERIFIED", "step_up":proof}),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
        assert_eq!(refused["error"]["code"], "exception_decide_forbidden");
        unchanged(&owner, id).await;
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn eligibility_uses_stored_requester_and_case_creation(owner: PgPool) {
    let (mut s, source, _) = pending(&owner).await;
    // The requester's grant is inside this case's lookback, but outside today's.
    let (id, binding) = copy_pending(
        &owner,
        source,
        "ENTITY_IDENTIFIER_CORRECTION",
        time::OffsetDateTime::now_utc() - time::Duration::days(30),
    )
    .await;
    sqlx::query(
        "UPDATE authz_grant_ledger SET occurred_at=now()-interval '10 days', actor_id=$2 \
         WHERE user_id=$1 AND event='GRANTED' AND grant_kind='SYSTEM_ROLE'",
    )
    .bind(s.approver.id)
    .bind(s.ops.id)
    .execute(&owner)
    .await
    .unwrap();
    assert!(!eligible(&owner, id, s.approver.id).await);
    let proof = step_up_with_binding(&owner, &s.svc, &mut s.approver, binding).await;
    let (status, refused) = send(
        &s.service,
        &format!("/api/v1/governed-exceptions/{id}/decide"),
        &s.approver.token,
        Some(&key()),
        json!({"decision":"APPROVE", "reason_code":"SECOND_PERSON_VERIFIED", "step_up":proof}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(refused["error"]["code"], "exception_decide_forbidden");
    unchanged(&owner, id).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn eligible_holder_with_branch_scoped_session_cannot_decide(owner: PgPool) {
    let (mut s, id, binding) = pending(&owner).await;
    let org: Uuid = sqlx::query_scalar("SELECT org_id FROM users WHERE id=$1")
        .bind(s.ops.id)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert!(eligible(&owner, id, s.approver.id).await);
    let token = period_unlock_support::session_token_in_scope(
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
    let proof = step_up_with_binding(&owner, &s.svc, &mut s.approver, binding).await;
    for decision in ["APPROVE", "DECLINE"] {
        let (status, refused) = send(
            &s.service,
            &format!("/api/v1/governed-exceptions/{id}/decide"),
            &token,
            Some(&key()),
            json!({"decision":decision, "reason_code":"SECOND_PERSON_VERIFIED", "step_up":proof}),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
        assert_eq!(refused["error"]["code"], "exception_decide_forbidden");
        unchanged(&owner, id).await;
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn identifier_decision_route_refuses_other_rules(owner: PgPool) {
    let (mut s, source, _) = pending(&owner).await;
    let (id, binding) = copy_pending(
        &owner,
        source,
        "ORG_CHANGE_BACKDATED",
        time::OffsetDateTime::now_utc(),
    )
    .await;
    let proof = step_up_with_binding(&owner, &s.svc, &mut s.approver, binding).await;
    let (status, refused) = send(
        &s.service,
        &format!("/api/v1/governed-exceptions/{id}/decide"),
        &s.approver.token,
        Some(&key()),
        json!({"decision":"APPROVE", "reason_code":"SECOND_PERSON_VERIFIED", "step_up":proof}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(refused["error"]["code"], "exception_rule_unsupported");
    unchanged(&owner, id).await;
}
