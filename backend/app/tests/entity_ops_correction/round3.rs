// SPDX-License-Identifier: LicenseRef-Proprietary
use super::maturity::{get, request};
use super::*;

const INBOX: &str = "/api/v1/me/action-inbox";

pub(super) async fn changes(owner: &PgPool, id: Uuid, action: &str) {
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM resource_changes r JOIN audit_events a ON a.id=r.audit_event_id WHERE a.target_id=$1 AND a.action=$2 AND r.resource_type='identifier_correction' AND r.resource_id=$1")
        .bind(id.to_string()).bind(action).fetch_one(owner).await.unwrap();
    assert_eq!(count, 1, "{action} must reach live readers");
}

pub(super) async fn inbox(s: &setup::Setup, token: &str) -> Vec<Value> {
    let (status, body) = get(s, INBOX, token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| {
            item["kind"]
                .as_str()
                .unwrap()
                .starts_with("identifier_correction")
        })
        .cloned()
        .collect()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn correction_inbox_is_my_work_and_moves_from_reviewer_to_requester(owner: PgPool) {
    let mut s = setup::setup(&owner).await;
    let (status, receipt, _) = request(&owner, &mut s).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{receipt}");
    let id: Uuid = receipt["exception_id"].as_str().unwrap().parse().unwrap();
    for token in [&s.ops.token, &s.member.token, &s.contributor.token] {
        assert!(inbox(&s, token).await.is_empty());
    }
    let rows = inbox(&s, &s.approver.token).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["kind"], "identifier_correction_decide");
    changes(&owner, id, "exception.request").await;
    assert_eq!(
        rows[0]["links"][0],
        json!({"kind":"identifier_correction", "id":id})
    );
    // A newer grant must not borrow eligibility from the older case.
    sqlx::query(
        "UPDATE authz_grant_ledger SET occurred_at=now() WHERE user_id=$1 AND event='GRANTED'",
    )
    .bind(s.approver.id)
    .execute(&owner)
    .await
    .unwrap();
    assert!(inbox(&s, &s.approver.token).await.is_empty());
    sqlx::query("UPDATE authz_grant_ledger SET occurred_at=now()-interval '400 days' WHERE user_id=$1 AND event IN ('GRANTED','NOTICE_DELIVERED')")
        .bind(s.approver.id).execute(&owner).await.unwrap();
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
    changes(&owner, id, "exception.decide").await;
    assert!(inbox(&s, &s.approver.token).await.is_empty());
    let rows = inbox(&s, &s.ops.token).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["kind"], "identifier_correction_apply");
    let (_, detail) = get(
        &s,
        &format!("/api/v1/entity-identifier-corrections/{id}"),
        &s.ops.token,
    )
    .await;
    let mut proposal = detail["items"][0]["proposal"].clone();
    proposal["exception_id"] = json!(id);
    let (status, body) = send(
        &s.service,
        &format!("/api/v1/legal-entities/{}/identifier-corrections", s.entity),
        &s.ops.token,
        Some(&key()),
        proposal,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(inbox(&s, &s.ops.token).await.is_empty());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn correction_inbox_excludes_scoped_expired_declined_and_other_tenant_cases(owner: PgPool) {
    use console_kernel_core::{AccessScope, AccessScopeLevel, ScopeNodeId};
    let mut s = setup::setup(&owner).await;
    let (_, receipt, _) = request(&owner, &mut s).await;
    let id: Uuid = receipt["exception_id"].as_str().unwrap().parse().unwrap();
    let org: Uuid = sqlx::query_scalar("SELECT org_id FROM users WHERE id=$1")
        .bind(s.ops.id)
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
    assert!(inbox(&s, &scoped).await.is_empty());
    let other = setup::setup(&owner).await;
    assert!(inbox(&other, &other.approver.token).await.is_empty());
    assert_eq!(inbox(&s, &s.approver.token).await.len(), 1);
    let (status, body) = send(
        &s.service,
        &format!("/api/v1/governed-exceptions/{id}/decide"),
        &s.approver.token,
        Some(&key()),
        json!({"decision":"DECLINE","reason_code":"DOCUMENT_MISMATCH"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(inbox(&s, &s.approver.token).await.is_empty());
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO governed_exceptions (org_id,rule_code,risk,subject_type,subject_id,reason_code,fingerprint,affected_periods,settings_snapshot,requested_by,status,fallback_kind,expires_at,created_at) SELECT org_id,rule_code,risk,subject_type,subject_id,reason_code,fingerprint,affected_periods,settings_snapshot,requested_by,'PENDING',fallback_kind,now()-interval '1 day',now()-interval '30 days' FROM governed_exceptions WHERE id=$1")
        .bind(id).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    assert!(inbox(&s, &s.approver.token).await.is_empty());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn correction_inbox_cursor_keeps_tied_cases_without_duplicates(owner: PgPool) {
    let mut s = setup::setup(&owner).await;
    let (_, receipt, _) = request(&owner, &mut s).await;
    let id: Uuid = receipt["exception_id"].as_str().unwrap().parse().unwrap();
    let (_, before) = get(&s, INBOX, &s.approver.token).await;
    let expected_total = before["total"].as_u64().unwrap() + 2;
    let org: Uuid = sqlx::query_scalar("SELECT org_id FROM users WHERE id=$1")
        .bind(s.ops.id)
        .fetch_one(&owner)
        .await
        .unwrap();
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO governed_exceptions (org_id,rule_code,risk,subject_type,subject_id,reason_code,fingerprint,affected_periods,settings_snapshot,requested_by,status,fallback_kind,expires_at,created_at) SELECT org_id,rule_code,risk,subject_type,subject_id,reason_code,fingerprint,affected_periods,settings_snapshot,requested_by,status,fallback_kind,expires_at,created_at FROM governed_exceptions CROSS JOIN generate_series(1,2) WHERE id=$1")
        .bind(id).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let mut uri = format!("{INBOX}?limit=1");
    let mut seen = std::collections::BTreeSet::new();
    let mut corrections = std::collections::BTreeSet::new();
    for _ in 0..expected_total {
        let (status, body) = get(&s, &uri, &s.approver.token).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["total"], expected_total, "{body}");
        assert_eq!(body["items"].as_array().unwrap().len(), 1);
        let item = &body["items"][0];
        let id = item["id"].as_str().unwrap().to_owned();
        assert!(seen.insert(id.clone()));
        if item["kind"] == "identifier_correction_decide" {
            corrections.insert(id);
        }
        if let Some(cursor) = body["next_cursor"].as_str() {
            uri = format!("{INBOX}?limit=1&cursor={cursor}");
        } else {
            break;
        }
    }
    assert_eq!(seen.len() as u64, expected_total);
    assert_eq!(corrections.len(), 3);
}
