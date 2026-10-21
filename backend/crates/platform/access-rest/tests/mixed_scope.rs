#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! governance-02 / people-self-01 (regression): an HR worker holding 인사 실무
//! over a 법인 AND 권한 관리 over 회사 전체 could not open the people list —
//! the tenant-level grant widened the principal to every branch, so the HR list
//! door (`authorize_hr_scoped`: an all-branch principal must pass the org-wide
//! gate) refused the 법인-scoped HR grant. A grant in a tenant-level domain
//! (권한 관리, 감사, 설정, 보존, 테넌트, 공지) must not move the branch scope the
//! data doors filter by.

mod support;

use console_kernel_core::{BranchId, BranchScope};
use console_platform_authz::{
    Action, Feature, Principal, authorize, authorize_capability, authorize_org_wide,
};
use console_platform_request_context::resolve_principal_from_bearer_token;
use serde_json::json;
use sqlx::PgPool;
use support::{World, grant_op, world};

async fn principal(w: &World, user: console_kernel_core::UserId) -> Principal {
    let token = w.token(user).await;
    resolve_principal_from_bearer_token(&w.verifier, &w.rt, &token)
        .await
        .unwrap()
}

/// The HR list door, as `hr/adapter-postgres/src/authz.rs::authorize_hr_scoped`.
fn hr_list_door(p: &Principal, feature: Feature) -> bool {
    match p.branch_scope {
        BranchScope::All => authorize_org_wide(p, Action::new(feature)).is_ok(),
        BranchScope::Branches(_) => authorize_capability(p, Action::new(feature)).is_ok(),
    }
}

async fn hr_and_access_roles(w: &World) -> (uuid::Uuid, uuid::Uuid) {
    let hr = w
        .role(
            "인사 실무",
            json!([
                { "domain": "hr_basic", "levels": ["view", "edit"] },
                { "domain": "org", "levels": ["view"] }
            ]),
        )
        .await;
    let access = w
        .role(
            "권한 관리 담당",
            json!([{ "domain": "access", "levels": ["view", "edit"] }]),
        )
        .await;
    (hr, access)
}

/// regression: governance-02 — red on 99dafebc (the list door refused).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_tenant_wide_access_grant_does_not_break_a_legal_entity_hr_grant(pool: PgPool) {
    let mut w = world(pool).await;
    // Signed in with zero grants first (the walk's order).
    let before = principal(&w, w.hr).await;
    assert!(!hr_list_door(&before, Feature::EmployeeDirectoryRead));

    let (hr, access) = hr_and_access_roles(&w).await;
    w.grant(json!([
        grant_op(w.hr, hr, "LEGAL_ENTITY", Some(w.le_a), false),
        grant_op(w.hr, access, "TENANT", None, false),
    ]))
    .await;
    w.go_live().await;

    let p = principal(&w, w.hr).await;
    assert!(
        hr_list_door(&p, Feature::EmployeeDirectoryRead),
        "인사 실무 over 법인 A opens the people list"
    );
    assert!(
        authorize(
            &p,
            Action::new(Feature::EmployeeDirectoryManage),
            BranchId::from_uuid(w.branch_a)
        )
        .is_ok(),
        "and edits inside 법인 A"
    );
    assert!(
        hr_list_door(&p, Feature::OrgChangeRead),
        "조직 조회 opens the org reads"
    );
    // Negative: the 권한 관리 grant over 회사 전체 does not reach 법인 B's people.
    assert!(
        authorize(
            &p,
            Action::new(Feature::EmployeeDirectoryRead),
            BranchId::from_uuid(w.branch_b)
        )
        .is_err(),
        "법인 B stays outside the HR grant"
    );
    assert_eq!(
        p.branch_scope,
        BranchScope::single(BranchId::from_uuid(w.branch_a)),
        "the data scope is the HR grant's, not the tenant"
    );
    // The tenant-level grant still works on its own doors.
    assert!(authorize_capability(&p, Action::new(Feature::UserManage)).is_ok());
}

/// A holder of ONLY a tenant-level grant keeps a scope to act in (no new 403).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_lone_access_grant_still_reaches_its_doors(pool: PgPool) {
    let mut w = world(pool).await;
    let (_, access) = hr_and_access_roles(&w).await;
    w.grant(json!([grant_op(w.hr, access, "TENANT", None, false)]))
        .await;
    w.go_live().await;
    let p = principal(&w, w.hr).await;
    assert!(authorize_capability(&p, Action::new(Feature::UserManage)).is_ok());
    assert!(
        !hr_list_door(&p, Feature::EmployeeDirectoryRead),
        "권한 관리 alone reads no people"
    );
}

/// The pilot shape for registration: 인사 실무 over 회사 전체 passes the
/// org-wide gate the HR create doors use, even next to a narrower grant.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_tenant_wide_hr_grant_passes_the_registration_gate(pool: PgPool) {
    let mut w = world(pool).await;
    let (hr, access) = hr_and_access_roles(&w).await;
    w.grant(json!([
        grant_op(w.hr, hr, "TENANT", None, false),
        grant_op(w.hr, access, "LEGAL_ENTITY", Some(w.le_b), false),
    ]))
    .await;
    w.go_live().await;
    let p = principal(&w, w.hr).await;
    assert!(authorize_org_wide(&p, Action::new(Feature::EmployeeDirectoryManage)).is_ok());
    assert!(hr_list_door(&p, Feature::EmployeeDirectoryRead));
}
