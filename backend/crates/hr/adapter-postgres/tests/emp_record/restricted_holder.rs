//! MR-35: a restricted read needs the org-wide holder (split from
//! `restricted.rs` under the 300-line ceiling).

use std::collections::BTreeSet;

use console_hr_domain::record::Section;
use console_kernel_core::BranchScope;
use console_platform_authz::{Principal, Role};
use sqlx::PgPool;

use crate::fixture::fixture;
use crate::restricted::purpose;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_restricted_read_needs_the_org_wide_holder(pool: PgPool) {
    let f = fixture(pool).await;
    let emp = f.employee("R-3").await;
    let narrow = Principal::new(
        f.principal.user_id,
        f.principal.org_id,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::Branches(BTreeSet::new()),
    );
    let err =
        f.hr.employee_records(
            narrow,
            emp,
            Some(Section::Discipline),
            false,
            purpose("DISCIPLINARY_PROCEDURE"),
        )
        .await
        .unwrap_err();
    assert_eq!(
        (err.status.as_u16(), err.code),
        (403, "record_restricted_forbidden")
    );
}
