// SPDX-License-Identifier: LicenseRef-Proprietary
//! Fixed-term renewal follows the registered statutory limit.
use sqlx::PgPool;

use crate::fixture;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn changing_the_registered_limit_changes_the_renewal_outcome(pool: PgPool) {
    let f = fixture(pool, Some(("2024-11-01", "2026-09-30"))).await;
    assert_eq!(
        f.renew("2026-12-31", None).await.unwrap_err(),
        (409, "fixed_term_limit".to_owned())
    );
    sqlx::query("UPDATE statutory_rules SET value_num=value_num+1 WHERE code='FIXED_TERM_MAX_YEARS' AND effective_from <= DATE '2026-09-30' AND (effective_to_exclusive IS NULL OR DATE '2026-09-30' < effective_to_exclusive)")
        .execute(&f.owner).await.unwrap();
    let view =
        f.hr.employee_fixed_term(f.principal.clone(), f.employee)
            .await
            .unwrap();
    assert_eq!(view.two_year_date.as_deref(), Some("2027-10-31"));
    f.renew("2026-12-31", None).await.unwrap();
}
