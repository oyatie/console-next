// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

const REGISTER: &str = "/api/v1/entity-identifier-corrections";

pub(super) async fn get(s: &setup::Setup, uri: &str, token: &str) -> (StatusCode, Value) {
    let response = s
        .service
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

pub(super) async fn request(owner: &PgPool, s: &mut setup::Setup) -> (StatusCode, Value, String) {
    let proof = step_up_as(
        owner,
        &s.svc,
        &mut s.ops,
        MobileStepUpActionKind::ExceptionDecide,
        s.entity,
        &format!("ENTITY_IDENTIFIER_CORRECTION\ncrn\n{FIXED}\n{}", s.doc),
    )
    .await;
    let intent = key();
    let (status, body) = send(
        &s.service,
        &format!("/api/v1/legal-entities/{}/identifier-corrections", s.entity),
        &s.ops.token,
        Some(&intent),
        json!({"field":"crn", "value":FIXED, "document_id":s.doc,
        "reason_code":"REGISTRY_DIFFERS", "step_up":proof}),
    )
    .await;
    (status, body, intent)
}

async fn old_evidence(owner: &PgPool, s: &setup::Setup) -> Uuid {
    let old = upload_tag(&s.service, &s.ops.token, "original").await;
    let org: Uuid = sqlx::query_scalar("SELECT org_id FROM users WHERE id=$1")
        .bind(s.ops.id)
        .fetch_one(owner)
        .await
        .unwrap();
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    // rls-arming: ok establish the currently attached certificate as an owner fixture.
    sqlx::query("UPDATE entity_documents SET legal_entity_id=$2 WHERE id=$1")
        .bind(old)
        .bind(s.entity)
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    old
}

async fn unchanged_evidence(owner: &PgPool, s: &setup::Setup, old: Uuid) {
    let current: (Option<Uuid>, Option<time::OffsetDateTime>) =
        sqlx::query_as("SELECT legal_entity_id, superseded_at FROM entity_documents WHERE id=$1")
            .bind(old)
            .fetch_one(owner)
            .await
            .unwrap();
    assert_eq!(
        current,
        (Some(s.entity), None),
        "pending evidence must not supersede the live certificate"
    );
    let proposed: (Option<Uuid>, Option<Uuid>) =
        sqlx::query_as("SELECT legal_entity_id, registration_id FROM entity_documents WHERE id=$1")
            .bind(s.doc)
            .fetch_one(owner)
            .await
            .unwrap();
    assert_eq!(
        proposed,
        (None, None),
        "the proposed certificate stays unattached"
    );
    let crn: String = sqlx::query_scalar("SELECT crn FROM legal_entities WHERE id=$1")
        .bind(s.entity)
        .fetch_one(owner)
        .await
        .unwrap();
    assert_eq!(crn, "1301110006246");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pending_and_declined_leave_live_evidence_untouched(owner: PgPool) {
    let mut s = setup::setup(&owner).await;
    let old = old_evidence(&owner, &s).await;
    let (status, receipt, _) = request(&owner, &mut s).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{receipt}");
    unchanged_evidence(&owner, &s, old).await;
    let id = receipt["exception_id"].as_str().unwrap();
    let (status, body) = send(
        &s.service,
        &format!("/api/v1/governed-exceptions/{id}/decide"),
        &s.approver.token,
        Some(&key()),
        json!({"decision":"DECLINE", "reason_code":"DOCUMENT_MISMATCH", "note":"번호와 증빙을 다시 대조하십시오"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    unchanged_evidence(&owner, &s, old).await;
    let (_, detail) = get(&s, &format!("{REGISTER}/{id}"), &s.ops.token).await;
    assert_eq!(
        detail["items"][0]["decision_note"],
        "번호와 증빙을 다시 대조하십시오"
    );
    let (status, refused) = send(&s.service, &format!("/api/v1/legal-entities/{}/identifier-corrections", s.entity),
        &s.ops.token, Some(&key()), json!({"field":"crn", "value":FIXED, "document_id":s.doc, "reason_code":"REGISTRY_DIFFERS", "exception_id":id})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "exception_not_approved");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn register_recovers_proposal_and_approved_request_applies_once(owner: PgPool) {
    let mut s = setup::setup(&owner).await;
    let old = old_evidence(&owner, &s).await;
    let (status, receipt, intent) = request(&owner, &mut s).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{receipt}");
    let (status, lost) = get(&s, &format!("/api/v1/requests/{intent}"), &s.ops.token).await;
    assert_eq!(status, StatusCode::OK, "{lost}");
    assert!(
        lost.to_string()
            .contains(receipt["exception_id"].as_str().unwrap()),
        "{lost}"
    );
    let (status, list) = get(&s, REGISTER, &s.approver.token).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let (detail_status, detail) = get(
        &s,
        &format!("{REGISTER}/{}", receipt["exception_id"].as_str().unwrap()),
        &s.approver.token,
    )
    .await;
    assert_eq!(detail_status, StatusCode::OK, "{detail}");
    let row = &detail["items"][0];
    assert_eq!(row["id"], receipt["exception_id"]);
    assert_eq!(row["can_decide"], true);
    assert_eq!(row["proposal"]["value"], FIXED);
    assert_eq!(row["proposal"]["document_id"], s.doc.to_string());
    assert_eq!(row["entity_id"], s.entity.to_string());
    assert_eq!(row["can_apply"], false);
    let id: Uuid = row["id"].as_str().unwrap().parse().unwrap();
    let binding = MobilePasskeyStepUpBinding::bound(
        MobileStepUpActionKind::ExceptionDecide,
        id,
        receipt["payload_hash"].as_str().unwrap().to_owned(),
    );
    let proof = step_up_with_binding(&owner, &s.svc, &mut s.approver, binding).await;
    let (status, decision) = send(
        &s.service,
        &format!("/api/v1/governed-exceptions/{id}/decide"),
        &s.approver.token,
        Some(&key()),
        json!({"decision":"APPROVE", "reason_code":"SECOND_PERSON_VERIFIED", "step_up":proof}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{decision}");
    assert_eq!(count(&owner, "SELECT count(*) FROM audit_events WHERE action='exception.decide' AND target_id=$1::text AND command_id IS NOT NULL", id).await, 1);
    let (_, list) = get(&s, REGISTER, &s.ops.token).await;
    assert_eq!(list["items"][0]["status"], "APPROVED");
    assert_eq!(list["items"][0]["can_apply"], true);
    let mut proposal = list["items"][0]["proposal"].clone();
    proposal["exception_id"] = json!(id);
    let uri = format!("/api/v1/legal-entities/{}/identifier-corrections", s.entity);
    let apply = key();
    let (status, body) = send(
        &s.service,
        &uri,
        &s.ops.token,
        Some(&apply),
        proposal.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["change_mode"], "GOVERNED");
    let (status, replay) = send(&s.service, &uri, &s.ops.token, Some(&apply), proposal).await;
    assert_eq!(status, StatusCode::CONFLICT, "{replay}");
    assert_eq!(replay["error"]["code"], "command_applied");
    assert_eq!(
        count(
            &owner,
            "SELECT count(*) FROM entity_identifier_corrections WHERE legal_entity_id=$1",
            s.entity
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &owner,
            "SELECT count(*) FROM entity_documents WHERE id=$1 AND superseded_at IS NOT NULL",
            old
        )
        .await,
        1
    );
    assert_eq!(count(&owner, "SELECT count(*) FROM audit_events WHERE action='entity_document.attach' AND target_id=$1::text", s.doc).await, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn recorded_queue_has_review_deadline_and_independent_signoff(owner: PgPool) {
    let mut s = setup::setup(&owner).await;
    sqlx::query("UPDATE users SET roles=ARRAY['MEMBER'] WHERE id=$1")
        .bind(s.approver.id)
        .execute(&owner)
        .await
        .unwrap();
    let (status, receipt, _) = request(&owner, &mut s).await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    let (status, list) = get(&s, REGISTER, &s.ops.token).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let row = &list["items"][0];
    assert_eq!(row["status"], "RECORDED");
    assert!(row["review_due_at"].is_string(), "{row}");
    assert_eq!(row["reviewed_at"], Value::Null);
    let id = row["id"].as_str().unwrap();
    let uri = format!("{REGISTER}/{id}/review");
    let (status, body) = send(
        &s.service,
        &uri,
        &s.ops.token,
        Some(&key()),
        json!({"note":"검토"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "exception_self_decision");
    let (status, body) = send(
        &s.service,
        &uri,
        &s.member.token,
        Some(&key()),
        json!({"note":"검토"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "exception_decide_forbidden");
    let (status, body) = send(
        &s.service,
        &uri,
        &s.contributor.token,
        Some(&key()),
        json!({"note":"검토"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "exception_contributor_decision");
    sqlx::query("UPDATE users SET roles=ARRAY['SUPER_ADMIN'] WHERE id=$1")
        .bind(s.approver.id)
        .execute(&owner)
        .await
        .unwrap();
    // Let the controller's restored grant age and deliver its notice, as in the shared holder fixture.
    sqlx::query("UPDATE authz_grant_ledger SET occurred_at=now()-interval '400 days' WHERE user_id=$1 AND event='GRANTED'").bind(s.approver.id).execute(&owner).await.unwrap();
    sqlx::query("INSERT INTO authz_grant_ledger (org_id,user_id,grant_kind,grant_ref,event,source,channel) SELECT org_id,user_id,grant_kind,grant_ref,'NOTICE_DELIVERED','NOTIFIER','IN_APP' FROM authz_grant_ledger WHERE user_id=$1 AND event='GRANTED' AND grant_kind='SYSTEM_ROLE'").bind(s.approver.id).execute(&owner).await.unwrap();
    let (_, queue) = get(&s, &format!("{REGISTER}?awaiting=me"), &s.approver.token).await;
    assert_eq!(queue["items"].as_array().unwrap().len(), 1, "{queue}");
    assert_eq!(queue["items"][0]["can_review"], true);
    assert!(queue["items"][0]["review_due_at"].is_string());
    for _ in 0..2 {
        let (status, body) = send(
            &s.service,
            &uri,
            &s.approver.token,
            Some(&key()),
            json!({"note":"증빙과 정정 기록 확인"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let id: Uuid = id.parse().unwrap();
    assert_eq!(count(&owner, "SELECT count(*) FROM audit_events WHERE action='exception.review' AND target_id=$1::text", id).await, 1);
    let (_, list) = get(&s, REGISTER, &s.ops.token).await;
    assert!(list["items"][0]["reviewed_at"].is_string());
    let (_, queue) = get(&s, &format!("{REGISTER}?awaiting=me"), &s.approver.token).await;
    assert_eq!(queue["items"], json!([]));
}
