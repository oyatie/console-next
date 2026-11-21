// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::{Body, to_bytes};
use console_inbox_adapter_postgres::PgInboxStore;
use console_inbox_application::EmitInboxDocCommand;
use console_inbox_domain::{InboxDocKind, NewInboxDoc};
use console_inbox_rest::{InboxRestState, ME_INBOX_DOCS_PATH, router};
use console_kernel_core::{OrgId, TraceContext, UserId};
use console_platform_auth::{AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier};
use console_platform_test_support::runtime_role_pool;
use http::{Request, StatusCode, header};
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::Generate;
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn payslip_meta_is_projected_for_payslips_with_dates_and_withheld_for_notices(pool: PgPool) {
    let org = OrgId::one();
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, 'inbox-meta', 'Inbox Meta') ON CONFLICT (id) DO NOTHING",
    )
    .bind(org.as_uuid())
    .execute(&pool)
    .await
    .unwrap();

    let user = UserId::new();
    let actor = UserId::new();
    for (uid, name) in [(user, "Member"), (actor, "Admin")] {
        sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
            .bind(uid.as_uuid())
            .bind(name)
            .bind(["MEMBER"].as_slice())
            .bind(org.as_uuid())
            .execute(&pool)
            .await
            .unwrap();
    }

    let store = PgInboxStore::new(pool.clone());
    console_platform_request_context::scope_org(org, async {
        store
            .emit_inbox_doc(EmitInboxDocCommand {
                recipient: user,
                actor: Some(actor),
                doc: NewInboxDoc {
                    kind: InboxDocKind::Payslip,
                    notice_type: None,
                    title: "2026-06 Payslip".to_owned(),
                    payload: json!({
                        "attribution_month": "2026-06",
                        "period_start": "2026-06-01",
                        "period_end": "2026-06-30",
                        "pay_date": "2026-06-25",
                        "gross_won": 3_200_000,
                        "net_won": 2_900_000,
                    }),
                    legal_basis: Some("LSA Art. 48".to_owned()),
                    source_kind: Some("payroll_run".to_owned()),
                    source_id: Some("r1".to_owned()),
                },
                dedup_key: Some("meta-full".to_owned()),
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
            .unwrap();

        store
            .emit_inbox_doc(EmitInboxDocCommand {
                recipient: user,
                actor: Some(actor),
                doc: NewInboxDoc {
                    kind: InboxDocKind::Payslip,
                    notice_type: None,
                    title: "Incomplete Payslip".to_owned(),
                    payload: json!({ "gross_won": 1_000_000 }),
                    legal_basis: None,
                    source_kind: None,
                    source_id: None,
                },
                dedup_key: Some("meta-missing-dates".to_owned()),
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
            .unwrap();

        store
            .emit_inbox_doc(EmitInboxDocCommand {
                recipient: user,
                actor: Some(actor),
                doc: NewInboxDoc {
                    kind: InboxDocKind::LegalNotice,
                    notice_type: Some("annual_leave_promotion".to_owned()),
                    title: "Leave Promotion".to_owned(),
                    payload: json!({ "period_start": "2026-06-01", "period_end": "2026-06-30" }),
                    legal_basis: None,
                    source_kind: None,
                    source_id: None,
                },
                dedup_key: Some("legal-1".to_owned()),
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
            .unwrap();
    })
    .await;

    let signing_key = SigningKey::generate();
    let priv_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let pub_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let issuer = JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: "console-platform-auth".to_owned(),
            audience: "console-api".to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        priv_pem.as_bytes(),
        pub_pem.as_bytes(),
    )
    .unwrap();
    let verifier = JwtVerifier::from_es256_public_pem(
        JwtSettings {
            issuer: "console-platform-auth".to_owned(),
            audience: "console-api".to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        pub_pem.as_bytes(),
    )
    .unwrap();
    let token = console_platform_test_support::issue_session_token(
        &pool,
        &issuer,
        AccessTokenInput {
            subject: user,
            org_id: org,
            roles: vec!["MEMBER".to_owned()],
            branches: vec![],
            platform: false,
            support: None,
            read_only: false,
            display_name: None,
            feature_grants: vec![],
            authz_subject_version: 0,
            authz_policy_version: 0,
            session_generation: 0,
            issued_at: OffsetDateTime::now_utc(),
        },
        None,
        vec![],
    )
    .await;

    let app = router(InboxRestState::new(
        PgInboxStore::new(runtime_role_pool(&pool).await),
        Some(verifier),
    ));

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("{ME_INBOX_DOCS_PATH}?filter=pay"))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&to_bytes(resp.into_body(), usize::MAX).await.unwrap()).unwrap();
    let items = body["items"].as_array().unwrap();
    assert_eq!(
        items.len(),
        2,
        "filter=pay must exclude legal_notice: {body}"
    );
    let full = items
        .iter()
        .find(|i| i["title"] == "2026-06 Payslip")
        .unwrap();
    assert_eq!(full["payslip_meta"]["attribution_month"], "2026-06");
    assert_eq!(full["payslip_meta"]["period_start"], "2026-06-01");
    assert_eq!(full["payslip_meta"]["period_end"], "2026-06-30");
    assert_eq!(full["payslip_meta"]["pay_date"], "2026-06-25");
    assert_eq!(full["payslip_meta"]["gross_won"], 3_200_000);
    assert_eq!(full["payslip_meta"]["net_won"], 2_900_000);

    let missing = items
        .iter()
        .find(|i| i["title"] == "Incomplete Payslip")
        .unwrap();
    assert!(missing.get("payslip_meta").is_none() || missing["payslip_meta"].is_null());

    let all_resp = app
        .oneshot(
            Request::builder()
                .uri(format!("{ME_INBOX_DOCS_PATH}?filter=all"))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let all_body: Value =
        serde_json::from_slice(&to_bytes(all_resp.into_body(), usize::MAX).await.unwrap()).unwrap();
    let legal = all_body["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["kind"] == "legal_notice")
        .unwrap();
    assert!(legal.get("payslip_meta").is_none() || legal["payslip_meta"].is_null());
}
