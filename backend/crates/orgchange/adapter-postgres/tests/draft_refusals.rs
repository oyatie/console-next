// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]
use console_kernel_core::{ErrorKind, OrgId};
use console_orgchange_adapter_postgres::{CreateOrgChange, PgOrgChangeError, PgOrgChangeStore};
use console_orgchange_domain::{OrgChangeKind, OrgChangeTarget, OrgProposalOp, TargetKind};
use console_platform_request_context::scope_org;
use console_platform_test_support::{
    runtime_role_pool, seed_active_user, seed_org_and_super_admin,
};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn create_admission_refuses_before_any_business_or_audit_write(pool: PgPool) {
    let org = OrgId::new();
    seed_org_and_super_admin(&pool, *org.as_uuid(), "draft-refusal").await;
    let member = seed_active_user(&pool, *org.as_uuid(), "MEMBER", "drafter").await;
    let store = PgOrgChangeStore::new(runtime_role_pool(&pool).await);
    let before = snapshot(&pool).await;
    for (kind, target_ref, error_kind) in [
        (
            TargetKind::OrgUnit,
            "not-a-uuid".to_owned(),
            ErrorKind::Validation,
        ),
        (
            TargetKind::Region,
            Uuid::new_v4().to_string(),
            ErrorKind::Forbidden,
        ),
    ] {
        let command = CreateOrgChange {
            kind: OrgChangeKind::New,
            target: OrgChangeTarget {
                kind,
                target_ref,
                label: "조직".into(),
            },
            effective_date: time::OffsetDateTime::now_utc().date() + time::Duration::days(1),
            reason: "기안 거절 검증".into(),
            proposal: vec![OrgProposalOp::DeactivateRegion {
                region_id: Uuid::new_v4(),
            }],
            supersedes_id: None,
            idempotency_key: Uuid::new_v4().to_string(),
            fingerprint_input: json!({}),
        };
        let error = scope_org(org, store.create(member, command))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), error_kind);
        if error_kind == ErrorKind::Forbidden {
            assert!(
                matches!(error, PgOrgChangeError::Domain(e) if e.code == Some("org_change.refuse.missing_grant"))
            );
        }
        assert_eq!(snapshot(&pool).await, before);
    }
}

async fn snapshot(pool: &PgPool) -> serde_json::Value {
    sqlx::query_scalar("SELECT jsonb_build_array((SELECT count(*) FROM org_change_requests),(SELECT count(*) FROM org_change_approval_steps),(SELECT count(*) FROM org_change_events),(SELECT count(*) FROM audit_events))")
        .fetch_one(pool).await.unwrap()
}
