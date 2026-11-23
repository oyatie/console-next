// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]

use console_leave_adapter_postgres::PgLeaveError;
use sqlx::PgPool;

use super::apply_failure;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn apply_failure_maps_unique_violations_to_409_never_500(pool: PgPool) {
    let err_prehire = sqlx::query(
        "DO $$ BEGIN \
            RAISE EXCEPTION 'dup' USING ERRCODE = '23505', CONSTRAINT = 'employees_prehire_not_issued_identity_idx'; \
         END $$;",
    )
    .execute(&pool)
    .await
    .unwrap_err();
    let mapped_prehire = apply_failure(PgLeaveError::from(err_prehire));
    assert_eq!(
        (mapped_prehire.status.as_u16(), mapped_prehire.code),
        (409, "duplicate_candidate")
    );

    let err_emp_no = sqlx::query(
        "DO $$ BEGIN \
            RAISE EXCEPTION 'dup' USING ERRCODE = '23505', CONSTRAINT = 'employees_org_employee_number_key'; \
         END $$;",
    )
    .execute(&pool)
    .await
    .unwrap_err();
    let mapped_emp_no = apply_failure(PgLeaveError::from(err_emp_no));
    assert_eq!(
        (mapped_emp_no.status.as_u16(), mapped_emp_no.code),
        (409, "employee_number_taken")
    );

    let err_other = sqlx::query(
        "DO $$ BEGIN \
            RAISE EXCEPTION 'dup' USING ERRCODE = '23505', CONSTRAINT = 'some_other_unique_idx'; \
         END $$;",
    )
    .execute(&pool)
    .await
    .unwrap_err();
    let mapped_other = apply_failure(PgLeaveError::from(err_other));
    assert_eq!(
        (mapped_other.status.as_u16(), mapped_other.code),
        (409, "rows_changed_since_preview")
    );
}
