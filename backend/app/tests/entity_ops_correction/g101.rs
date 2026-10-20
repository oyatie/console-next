// SPDX-License-Identifier: LicenseRef-Proprietary
#[path = "setup.rs"]
mod setup;
use super::*;
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn acceptance_crud_g101_second_person_on_entity_identifier_correction(owner: PgPool) {
    let setup::Setup {
        service,
        issuer,
        svc,
        mut ops,
        mut approver,
        mut contributor,
        mut member,
        entity,
        doc,
    } = setup::setup(&owner).await;
    let uri = format!("/api/v1/legal-entities/{entity}/identifier-corrections");
    let fix = json!({ "field": "crn", "value": "110111-0012345", "document_id": doc, "reason_code": "REGISTRY_DIFFERS" });
    let line = format!("ENTITY_IDENTIFIER_CORRECTION\ncrn\n{FIXED}\n{doc}");
    let kind = MobileStepUpActionKind::ExceptionDecide;

    // Ops with its step-up: with a second eligible holder (approver), the correction
    // cannot be recorded as sole-holder. It is PENDING, not RECORDED.
    let mine = step_up_as(&owner, &svc, &mut ops, kind, entity, &line).await;
    let mut with_step_up = fix.clone();
    with_step_up["step_up"] = mine;
    let pending_key = key();
    let (status, resp) = send(
        &service,
        &uri,
        &ops.token,
        Some(&pending_key),
        with_step_up.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{resp}");
    assert_eq!(resp["status"], "PENDING");
    let exc_id: Uuid = resp["exception_id"].as_str().unwrap().parse().unwrap();
    let binding = MobilePasskeyStepUpBinding::bound(
        kind,
        exc_id,
        resp["payload_hash"].as_str().unwrap().to_owned(),
    );
    let (status, replay) = send(
        &service,
        &uri,
        &ops.token,
        Some(&pending_key),
        with_step_up.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{replay}");
    assert_eq!(replay, resp);
    let (status, refused) = send(&service, &uri, &ops.token, Some(&key()), with_step_up).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(refused["error"]["code"], "passkey_step_up_failed");
    assert_eq!(
        count(
            &owner,
            "SELECT COUNT(*) FROM governed_exceptions WHERE subject_id=$1",
            entity
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &owner,
            "SELECT COUNT(*) FROM entity_identifier_corrections WHERE legal_entity_id=$1",
            entity
        )
        .await,
        0
    );
    assert_eq!(count(&owner, "SELECT COUNT(*) FROM governed_exceptions e JOIN step_up_assertions s ON s.ceremony_id=e.step_up_assertion_id WHERE e.id=$1", exc_id).await, 1);
    let current: String = sqlx::query_scalar("SELECT crn FROM legal_entities WHERE id=$1")
        .bind(entity)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(current, "1301110006246");

    // The exception is stored as PENDING (not RECORDED) with fallback_kind SECOND_PERSON:
    let (stored_id, rule, exc_status, fallback, by): (Uuid, String, String, Option<String>, Uuid) =
        sqlx::query_as(
            "SELECT id, rule_code, status, fallback_kind, requested_by \
         FROM governed_exceptions WHERE subject_id = $1",
        )
        .bind(entity)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(stored_id, exc_id);
    assert_eq!(
        (rule.as_str(), exc_status.as_str(), fallback.as_deref(), by),
        (
            "ENTITY_IDENTIFIER_CORRECTION",
            "PENDING",
            Some("SECOND_PERSON"),
            ops.id,
        )
    );

    let decide_uri = format!("/api/v1/exceptions/{exc_id}/decide");

    // Refusal test 1: Requester cannot decide their own exception (decider != requester).
    let ops_step_up = step_up_with_binding(&owner, &svc, &mut ops, binding.clone()).await;
    let (status, refused) = send(
        &service,
        &decide_uri,
        &ops.token,
        Some(&key()),
        json!({
            "decision": "APPROVE",
            "reason_code": "SECOND_PERSON_VERIFIED",
            "step_up": ops_step_up,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(refused["error"]["code"], "exception_self_decision");

    let (status, refused) = send(
        &service,
        &decide_uri,
        &approver.token,
        Some(&key()),
        json!({"decision":"APPROVE", "reason_code":"SECOND_PERSON_VERIFIED", "contributed":false}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refused}");

    // Refusal test 2: Approver approving without step-up is refused.
    let (status, refused) = send(
        &service,
        &decide_uri,
        &approver.token,
        Some(&key()),
        json!({
            "decision": "APPROVE",
            "reason_code": "SECOND_PERSON_VERIFIED",
        }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(refused["error"]["code"], "step_up_required");

    // A valid holder in another tenant cannot discover or decide this exception.
    let foreign = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, '타 조직')")
        .bind(foreign)
        .bind(format!("foreign-{}", &foreign.simple().to_string()[..12]))
        .execute(&owner)
        .await
        .unwrap();
    let mut outsider = admin_in(
        &owner,
        &svc,
        &issuer,
        OrgId::from_uuid(foreign),
        "다른 조직 관리자",
    )
    .await;
    let proof = step_up_with_binding(&owner, &svc, &mut outsider, binding.clone()).await;
    let (status, refused) = send(
        &service,
        &decide_uri,
        &outsider.token,
        Some(&key()),
        json!({"decision":"APPROVE", "reason_code":"SECOND_PERSON_VERIFIED", "step_up":proof}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{refused}");
    assert_eq!(refused["error"]["code"], "exception_not_found");

    // Every dimension of the decision binding comes from stored server state.
    for wrong in [
        MobilePasskeyStepUpBinding::bound(
            MobileStepUpActionKind::PeriodUnlock,
            exc_id,
            resp["payload_hash"].as_str().unwrap().to_owned(),
        ),
        MobilePasskeyStepUpBinding::bound(
            kind,
            Uuid::new_v4(),
            resp["payload_hash"].as_str().unwrap().to_owned(),
        ),
        MobilePasskeyStepUpBinding::bound(kind, exc_id, "0".repeat(64)),
    ] {
        let proof = step_up_with_binding(&owner, &svc, &mut approver, wrong).await;
        let (status, refused) = send(
            &service,
            &decide_uri,
            &approver.token,
            Some(&key()),
            json!({"decision":"APPROVE","reason_code":"SECOND_PERSON_VERIFIED","step_up":proof}),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
        assert_eq!(refused["error"]["code"], "step_up_required");
    }
    let proof = step_up_with_binding(&owner, &svc, &mut contributor, binding.clone()).await;
    let (status, refused) = send(
        &service,
        &decide_uri,
        &contributor.token,
        Some(&key()),
        json!({"decision":"APPROVE","reason_code":"SECOND_PERSON_VERIFIED","step_up":proof}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(refused["error"]["code"], "exception_contributor_decision");
    let proof = step_up_with_binding(&owner, &svc, &mut member, binding.clone()).await;
    let (status, refused) = send(
        &service,
        &decide_uri,
        &member.token,
        Some(&key()),
        json!({"decision":"APPROVE","reason_code":"SECOND_PERSON_VERIFIED","step_up":proof}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(refused["error"]["code"], "exception_decide is not allowed");
    // A decline also requires permission, even though it needs no step-up.
    let (status, refused) = send(
        &service,
        &decide_uri,
        &member.token,
        Some(&key()),
        json!({"decision":"DECLINE","reason_code":"NOT_VERIFIED"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(count(&owner, "SELECT COUNT(*) FROM audit_events WHERE target_type='governed_exception' AND action='exception.decide' AND target_id=$1::text", exc_id).await, 0);
    let state: String = sqlx::query_scalar("SELECT status FROM governed_exceptions WHERE id=$1")
        .bind(exc_id)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(state, "PENDING");

    // A refusal by an eligible second person is audited and never admits the write.
    let mine = step_up_as(&owner, &svc, &mut ops, kind, entity, &line).await;
    let mut second_request = fix.clone();
    second_request["step_up"] = mine;
    let (status, pending) = send(&service, &uri, &ops.token, Some(&key()), second_request).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{pending}");
    let declined_id: Uuid = pending["exception_id"].as_str().unwrap().parse().unwrap();
    let (status, declined) = send(
        &service,
        &format!("/api/v1/exceptions/{declined_id}/decide"),
        &approver.token,
        Some(&key()),
        json!({"decision":"DECLINE", "reason_code":"NOT_VERIFIED"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{declined}");
    assert_eq!(declined["status"], "DECLINED");
    assert_eq!(count(&owner, "SELECT COUNT(*) FROM audit_events WHERE action='exception.decide' AND target_id=$1::text AND after_snap->>'status'='DECLINED'", declined_id).await, 1);
    let mut rejected_fix = fix.clone();
    rejected_fix["exception_id"] = json!(declined_id);
    let (status, refused) = send(&service, &uri, &ops.token, Some(&key()), rejected_fix).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "exception_not_approved");

    // Success test: Approver decides with step-up.
    let approver_step_up = step_up_with_binding(&owner, &svc, &mut approver, binding.clone()).await;
    let (status, approved) = send(
        &service,
        &decide_uri,
        &approver.token,
        Some(&key()),
        json!({
            "decision": "APPROVE",
            "reason_code": "SECOND_PERSON_VERIFIED",
            "step_up": approver_step_up,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{approved}");
    assert_eq!(approved["status"], "APPROVED");
    let (actor, before, after): (Uuid, Value, Value) = sqlx::query_as("SELECT actor, before_snap, after_snap FROM audit_events WHERE target_type='governed_exception' AND action='exception.decide' AND target_id=$1::text").bind(exc_id).fetch_one(&owner).await.unwrap();
    assert_eq!(actor, approver.id);
    assert_eq!(before["status"], "PENDING");
    assert_eq!(after["status"], "APPROVED");
    assert_eq!(after["decided_by"], approver.id.to_string());
    assert!(after["step_up_assertion_id"].is_string());

    // Refusal test 3: Deciding an already decided exception is refused.
    let (status, refused) = send(
        &service,
        &decide_uri,
        &approver.token,
        Some(&key()),
        json!({
            "decision": "APPROVE",
            "reason_code": "SECOND_PERSON_VERIFIED",
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "exception_not_pending");

    // Now the approved exception can be consumed: ops submits with exception_id.
    let mut with_exc = fix.clone();
    with_exc["exception_id"] = json!(exc_id);
    let (status, saved) = send(&service, &uri, &ops.token, Some(&key()), with_exc).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["change_mode"], "GOVERNED");
    assert_eq!(saved["record"]["crn"]["value"], FIXED);
}
