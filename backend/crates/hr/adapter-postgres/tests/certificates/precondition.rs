// SPDX-License-Identifier: LicenseRef-Proprietary
use super::fixture::World;
use crate::lifecycle_grant;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scoped_issuer_reads_only_own_precondition_and_can_issue(pool: PgPool) {
    use console_kernel_core::{BranchScope, UserId};
    use console_platform_authz::{
        Feature, Principal, Role,
        access::{NodeKind, ScopeGrant},
    };
    use std::collections::BTreeSet;
    let w = World::new(pool.clone()).await;
    let other = World::new(pool).await;
    let actor = UserId::new();
    sqlx::query("INSERT INTO users(id,org_id,display_name,roles) VALUES($1,$2,'Scoped issuer',ARRAY['MEMBER'])")
        .bind(actor.as_uuid()).bind(w.actor.org_id.as_uuid()).execute(&w.owner).await.unwrap();
    lifecycle_grant::grant_hr_basic(
        &w.owner,
        *w.actor.org_id.as_uuid(),
        *actor.as_uuid(),
        &["edit"],
    )
    .await;
    sqlx::query("WITH retired AS (UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE org_id=$1 AND account_id=$2 RETURNING *) INSERT INTO access_grants(org_id,account_id,role_id,scope_kind,legal_entity_id,valid_from,effective_in_setup,change_mode,reason_code,granted_by) SELECT org_id,account_id,role_id,'LEGAL_ENTITY',$3,valid_from,effective_in_setup,change_mode,reason_code,granted_by FROM retired")
        .bind(w.actor.org_id.as_uuid()).bind(actor.as_uuid()).bind(w.entity).execute(&w.owner).await.unwrap();
    let issuer = Principal::new(
        actor,
        w.actor.org_id,
        BTreeSet::from([Role::Member]),
        BranchScope::All,
    )
    .with_scope_grants(vec![ScopeGrant {
        feature: Feature::EmployeeDirectoryManage,
        kind: NodeKind::LegalEntity,
        id: w.entity,
    }]);
    let preflight =
        w.hr.certificate_precondition(issuer.clone(), w.employee)
            .await
            .unwrap();
    assert!(!preflight.settings_configured);
    assert_eq!(preflight.reason_code, Some("certificate_settings_required"));
    let refusal =
        w.hr.issue_certificate(
            issuer.clone(),
            Some(Uuid::new_v4().to_string()),
            w.issue_body(),
        )
        .await
        .unwrap_err();
    assert_eq!(refusal.status, http::StatusCode::CONFLICT);
    assert_eq!(refusal.code, "certificate_settings_required");
    w.configure().await;
    let preflight =
        w.hr.certificate_precondition(issuer.clone(), w.employee)
            .await
            .unwrap();
    assert!(preflight.settings_configured);
    assert_eq!(
        serde_json::to_value(preflight).unwrap(),
        json!({"settings_configured":true,"reason_code":null})
    );
    assert_eq!(
        w.hr.certificate_settings(issuer.clone())
            .await
            .unwrap_err()
            .code,
        "certificate_forbidden"
    );
    w.hr.issue_certificate(
        issuer.clone(),
        Some(Uuid::new_v4().to_string()),
        w.issue_body(),
    )
    .await
    .unwrap();
    let outside = World::entity(&w.owner, *w.actor.org_id.as_uuid(), "Outside scope").await;
    w.assign(outside).await;
    assert_eq!(
        w.hr.certificate_precondition(issuer.clone(), w.employee)
            .await
            .unwrap_err()
            .code,
        "certificate_forbidden"
    );
    assert_eq!(
        w.hr.certificate_precondition(issuer.clone(), other.employee)
            .await
            .unwrap_err()
            .code,
        "certificate_forbidden"
    );
    assert_eq!(
        w.hr.certificate_precondition(issuer, Uuid::new_v4())
            .await
            .unwrap_err()
            .code,
        "certificate_forbidden"
    );
    sqlx::query("UPDATE employment_assignments SET superseded_at=now() WHERE employee_id=$1 AND superseded_at IS NULL")
        .bind(w.employee).execute(&w.owner).await.unwrap();
    let preflight =
        w.hr.certificate_precondition(w.actor.clone(), w.employee)
            .await
            .unwrap();
    assert!(!preflight.settings_configured);
    assert_eq!(preflight.reason_code, Some("certificate_facts_missing"));
}
