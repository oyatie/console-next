#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use super::{access_tests::Fixture, all_readable, may_read};
use console_kernel_core::BranchScope;
use console_platform_authz::{EffectiveFeatureGrant, Feature, PermissionLevel};
use console_platform_test_support::MIGRATOR;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "MIGRATOR")]
async fn org_wide_employee_reader_denies_absent_malformed_and_foreign_records(pool: PgPool) {
    let f = Fixture::new(pool.clone()).await;
    let foreign = Fixture::new(pool).await;
    let existing = f.employee(f.branches[0]).await;
    let other_tenant = foreign.employee(foreign.branches[0]).await;
    let p = f
        .principal(BranchScope::All)
        .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
            Feature::EmployeeDirectoryRead,
            PermissionLevel::Allow,
            BranchScope::All,
        )]);
    assert!(may_read(&f.rt, &p, "employee", &existing.to_string(), None).await);
    for id in [
        Uuid::new_v4().to_string(),
        "bad-id".to_owned(),
        other_tenant.to_string(),
    ] {
        for branch in [None, Some(*f.branches[0].as_uuid())] {
            assert!(
                !may_read(&f.rt, &p, "employee", &id, branch).await,
                "an absent record cannot inherit org-wide or caller-supplied branch access"
            );
        }
    }
    assert!(
        !all_readable(
            &f.rt,
            &p,
            &json!([
                {"type":"employee_lifecycle_batch","id":Uuid::new_v4()},
                {"type":"employee","id":Uuid::new_v4(),"branch_id":f.branches[0]}
            ])
        )
        .await
    );
    assert!(
        !all_readable(
            &f.rt,
            &p,
            &json!([
                {"type":"employee","id":existing},
                {"type":"unknown_batch","id":Uuid::new_v4()}
            ])
        )
        .await
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn employee_reader_uses_current_home_branch_instead_of_a_stored_hint(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let inside = f.employee(f.branches[0]).await;
    let outside = f.employee(f.branches[1]).await;
    let scope = BranchScope::Branches(std::collections::BTreeSet::from([f.branches[0]]));
    let p = f
        .principal(scope.clone())
        .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
            Feature::EmployeeDirectoryRead,
            PermissionLevel::Allow,
            scope,
        )]);
    assert!(
        may_read(
            &f.rt,
            &p,
            "employee",
            &inside.to_string(),
            Some(*f.branches[1].as_uuid())
        )
        .await
    );
    assert!(
        !may_read(
            &f.rt,
            &p,
            "employee",
            &outside.to_string(),
            Some(*f.branches[0].as_uuid())
        )
        .await
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn employee_reader_treats_a_deactivated_home_branch_as_branchless(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let employee = f.employee(f.branches[0]).await;
    let scope = BranchScope::Branches(std::collections::BTreeSet::from([f.branches[0]]));
    let p = f
        .principal(scope.clone())
        .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
            Feature::EmployeeDirectoryRead,
            PermissionLevel::Allow,
            scope,
        )]);
    assert!(may_read(&f.rt, &p, "employee", &employee.to_string(), None).await);
    sqlx::query("UPDATE branches SET deactivated_at=now() WHERE org_id=$1 AND id=$2")
        .bind(f.org.as_uuid())
        .bind(f.branches[0].as_uuid())
        .execute(&f.owner)
        .await
        .unwrap(); // rls-arming: ok owner fixture
    assert!(
        !may_read(
            &f.rt,
            &p,
            "employee",
            &employee.to_string(),
            Some(*f.branches[0].as_uuid())
        )
        .await
    );
    let org_wide = f
        .principal(BranchScope::All)
        .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
            Feature::EmployeeDirectoryRead,
            PermissionLevel::Allow,
            BranchScope::All,
        )]);
    assert!(may_read(&f.rt, &org_wide, "employee", &employee.to_string(), None).await);
}
