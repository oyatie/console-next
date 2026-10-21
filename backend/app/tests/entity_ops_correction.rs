#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Decisions #26 item d through the router: after 운영 시작 a 법인등록번호
//! correction needs a governed exception, and the tenant ops account may
//! cover it itself (break-glass): its own passkey step-up bound to exactly
//! this correction, recorded as a sole-holder exception (사후 검토 due) and
//! audited. Everyone else, and ops without a matching step-up, is refused
//! with nothing written.

mod period_unlock_support;

#[path = "support/terms.rs"]
mod terms;

use axum::body::{Body, to_bytes};
use console_kernel_core::OrgId;
use console_platform_auth::MobileStepUpActionKind;
use console_platform_test_support::soft_passkey::passkey_service;
use http::{Request, StatusCode, header};
use period_unlock_support::{Admin, admin_in, router, send, step_up_as};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

const FIXED: &str = "0001110012348";

/// One user intent: a fresh Idempotency-Key.
fn key() -> String {
    Uuid::new_v4().to_string()
}

async fn upload(service: &axum::Router, token: &str) -> Uuid {
    let b = "d26boundary";
    let body = format!(
        "--{b}\r\nContent-Disposition: form-data; name=\"kind\"\r\n\r\nCORP_REGISTRY_EXTRACT\r\n\
         --{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"등기사항전부증명서.pdf\"\r\n\
         Content-Type: application/pdf\r\n\r\n%PDF-1.7 d26\r\n--{b}--\r\n"
    );
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/entity-documents")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={b}"),
        )
        .header("Idempotency-Key", Uuid::new_v4().to_string())
        .body(Body::from(body))
        .unwrap();
    let response = service.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let doc: Value = serde_json::from_slice(&bytes).unwrap_or(json!({}));
    assert_eq!(status, StatusCode::CREATED, "{doc}");
    doc["id"].as_str().unwrap().parse().unwrap()
}

/// As the owner with the tenant armed (fixture writes).
async fn armed(owner: &PgPool, org: Uuid, sql: &'static str, id: Uuid) {
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    // rls-arming: ok test fixture writes as owner with the tenant armed
    sqlx::query(sql).bind(id).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
}

async fn count(owner: &PgPool, sql: &'static str, id: Uuid) -> i64 {
    sqlx::query_scalar(sql)
        .bind(id)
        .fetch_one(owner)
        .await
        .unwrap()
}

/// regression (decisions #26 item d): before it, every post-go-live
/// identifier correction was refused `identifier_correction_needs_exception`
/// and no route could request that exception, so even ops was dead-ended.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_d26_ops_covers_a_post_go_live_correction_only_with_its_bound_step_up(
    owner: PgPool,
) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, '가나 콘솔')")
        .bind(org)
        .bind(format!("d26-{}", &org.simple().to_string()[..12]))
        .execute(&owner)
        .await
        .unwrap();
    let (service, issuer) = router(&owner).await;
    let svc = passkey_service();
    let tenant = OrgId::from_uuid(org);
    let mut ops: Admin = admin_in(&owner, &svc, &issuer, tenant, "운영 관리자").await;
    let mut hr: Admin = admin_in(&owner, &svc, &issuer, tenant, "인사 담당").await;
    sqlx::query("UPDATE users SET is_tenant_ops = true WHERE id = $1")
        .bind(ops.id)
        .execute(&owner)
        .await
        .unwrap();

    let (status, _) = send(
        &service,
        "/api/v1/onboarding/terms",
        &ops.token,
        Some(&key()),
        terms::publish(&owner).await,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, entity) = send(&service, "/api/v1/legal-entities", &ops.token, Some(&key()), json!({
        "biz_kind": "CORPORATION", "name": "주식회사 가나", "representation_mode": "SINGLE",
        "representatives": ["홍길동"], "crn": "000211-0006241",
        "head_office_address": { "source": "MANUAL_UNVERIFIED", "road_addr_part1": "서울특별시 강남구 테헤란로 152",
                                 "si_nm": "서울특별시", "sgg_nm": "강남구", "detail": "12층" },
    })).await;
    assert_eq!(status, StatusCode::CREATED, "{entity}");
    let entity: Uuid = entity["record"]["id"].as_str().unwrap().parse().unwrap();
    let doc = upload(&service, &ops.token).await;
    armed(
        &owner,
        org,
        "UPDATE tenant_phase SET phase = 'OPERATING' WHERE org_id = $1",
        org,
    )
    .await;
    armed(
        &owner,
        org,
        "UPDATE legal_entities SET identity_locked_at = now() WHERE id = $1",
        entity,
    )
    .await;

    let uri = format!("/api/v1/legal-entities/{entity}/identifier-corrections");
    let fix = json!({ "field": "crn", "value": "000111-0012348", "document_id": doc, "reason_code": "REGISTRY_DIFFERS" });
    let line = format!("ENTITY_IDENTIFIER_CORRECTION\ncrn\n{FIXED}\n{doc}");
    let kind = MobileStepUpActionKind::ExceptionDecide;
    let with = |step_up: Value| {
        let mut body = fix.clone();
        body["step_up"] = step_up;
        body
    };
    let ledger = "SELECT COUNT(*) FROM entity_identifier_corrections WHERE legal_entity_id = $1";
    let exceptions = "SELECT COUNT(*) FROM governed_exceptions WHERE subject_id = $1";

    // Negative: anyone but ops still needs an approved exception, step-up or not.
    let (status, refused) = send(&service, &uri, &hr.token, Some(&key()), fix.clone()).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(
        refused["error"]["code"],
        "identifier_correction_needs_exception"
    );
    let theirs = step_up_as(&owner, &svc, &mut hr, kind, entity, &line).await;
    let (status, refused) = send(&service, &uri, &hr.token, Some(&key()), with(theirs)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(
        refused["error"]["code"],
        "identifier_correction_needs_exception"
    );
    // Negative: ops without a step-up is asked for one (428).
    let (status, refused) = send(&service, &uri, &ops.token, Some(&key()), fix.clone()).await;
    assert_eq!(status, StatusCode::PRECONDITION_REQUIRED, "{refused}");
    assert_eq!(refused["error"]["code"], "passkey_step_up_required");
    // Negative: a step-up bound to another value never covers this one.
    let other = format!("ENTITY_IDENTIFIER_CORRECTION\ncrn\n0001110099991\n{doc}");
    let wrong = step_up_as(&owner, &svc, &mut ops, kind, entity, &other).await;
    let (status, refused) = send(&service, &uri, &ops.token, Some(&key()), with(wrong)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(refused["error"]["code"], "passkey_step_up_failed");
    // No side effect from any refusal.
    assert_eq!(count(&owner, ledger, entity).await, 0);
    assert_eq!(count(&owner, exceptions, entity).await, 0);

    // Ops with its own step-up bound to exactly this correction.
    let mine = step_up_as(&owner, &svc, &mut ops, kind, entity, &line).await;
    let (status, saved) = send(&service, &uri, &ops.token, Some(&key()), with(mine)).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["change_mode"], "SOLE_HOLDER");
    assert_eq!(saved["record"]["crn"]["value"], FIXED);
    let (rule, status, fallback, by, due): (String, String, String, Uuid, bool) = sqlx::query_as(
        "SELECT rule_code, status, fallback_kind, requested_by, review_due_at > now() \
         FROM governed_exceptions WHERE subject_id = $1",
    )
    .bind(entity)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        (rule.as_str(), status.as_str(), fallback.as_str(), by, due),
        (
            "ENTITY_IDENTIFIER_CORRECTION",
            "RECORDED",
            "SOLE_HOLDER",
            ops.id,
            true
        )
    );
    let audit: Value = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE action = 'legal_entity.correct_identifier' AND target_id = $1",
    )
    .bind(entity.to_string())
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(audit["ops_break_glass"], true, "{audit}");
    assert_eq!(count(&owner, ledger, entity).await, 1);
}
