// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]

use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn import_rollback_audit_trigger_is_owner_only_and_still_attached(pool: PgPool) {
    let privileges: (bool, bool, bool, bool, bool) = sqlx::query_as(
        "SELECT p.prosecdef, p.proowner = 'console_leave_definer'::regrole, \
                has_function_privilege('console_leave_cmd', p.oid, 'EXECUTE'), \
                has_function_privilege('console_rt', p.oid, 'EXECUTE'), \
                EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a \
                        WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') \
         FROM pg_proc p \
         WHERE p.oid = 'leave_api.employee_import_rollback_audit_required()'::regprocedure",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        privileges,
        (true, true, false, false, false),
        "the audit trigger runs as its definer; command, runtime and PUBLIC cannot execute it"
    );

    let attached: bool = sqlx::query_scalar(
        "SELECT t.tgenabled = 'O' AND t.tgdeferrable AND t.tginitdeferred \
         FROM pg_trigger t \
         WHERE t.tgrelid = 'data_import_runs'::regclass \
           AND t.tgname = 'employee_import_rollback_audit_required' \
           AND t.tgfoid = 'leave_api.employee_import_rollback_audit_required()'::regprocedure",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(attached, "rollback still requires its deferred audit guard");
}
