// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_kernel_core::OrgId;
use console_platform_auth::{
    MobilePasskeyStepUpBinding, MobileStepUpActionKind, PasskeyService, WebauthnSettings,
};
use console_platform_test_support::runtime_role_pool;
use sqlx::PgPool;
use time::Duration;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_persisted_step_up_kind_has_an_extensible_response_declaration(pool: PgPool) {
    let response = include_str!("../openapi/schemas/MobilePasskeyStepUpStartResponse.yaml");
    assert_eq!(response.matches("x-extensible-enum:").count(), 2);
    let user: Uuid = sqlx::query_scalar(
        "INSERT INTO users(display_name,org_id,roles) VALUES('Synthetic compatibility user',$1,ARRAY['MEMBER']) RETURNING id",
    )
    .bind(*OrgId::one().as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    let runtime = runtime_role_pool(&pool).await;
    let service = PasskeyService::new(WebauthnSettings {
        rp_id: "example.com".into(),
        rp_origin: url::Url::parse("https://auth.example.com").unwrap(),
        rp_name: "Console".into(),
        extra_allowed_origins: vec![],
        ceremony_ttl: Duration::minutes(5),
    })
    .unwrap();
    for kind in MobileStepUpActionKind::ALL {
        let binding = MobilePasskeyStepUpBinding {
            action_kind: kind,
            object_id: Uuid::new_v4(),
            reason_key: kind.expected_reason_key().into(),
            replay_attempt: None,
            payload_hash: match kind {
                MobileStepUpActionKind::ApprovalDecision | MobileStepUpActionKind::PollVote => None,
                _ => Some("a".repeat(64)),
            },
        };
        assert!(response.contains(&format!("- {}\n", kind.as_wire())));
        assert!(response.contains(&format!("- {}\n", binding.reason_key)));
        let ceremony = service
            .start_mobile_step_up(&runtime, user, binding.clone())
            .await
            .unwrap();
        let stored: (String, Uuid, String, Option<i32>, Option<String>) = sqlx::query_as(
            "SELECT action_kind,object_id,reason_key,replay_attempt,payload_hash FROM auth_webauthn_ceremony_bindings WHERE ceremony_id=$1",
        )
        .bind(ceremony.ceremony_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            stored,
            (
                kind.as_wire().into(),
                binding.object_id,
                binding.reason_key,
                binding.replay_attempt,
                binding.payload_hash
            )
        );
    }
}
