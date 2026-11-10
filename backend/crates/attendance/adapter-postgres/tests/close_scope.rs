// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
//! Organization closes cover each workplace without creating another snapshot.
use console_attendance_adapter_postgres::{AttendanceStoreError, PgAttendanceStore};
use console_attendance_application::{CallerScope, CloseMonth};
use console_kernel_core::OrgId;
use console_platform_request_context::scope_org;
use console_platform_test_support::{runtime_role_pool, seed_branch, seed_user};
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn organization_close_prevents_a_second_close_for_any_workplace(pool: PgPool) {
    scope_org(OrgId::one(), async {
        let branch = seed_branch(&pool, "close-scope", "operations").await;
        let actor = seed_user(&pool, "Attendance Closer", "SUPER_ADMIN", branch).await;
        let caller = CallerScope {
            org_id: *OrgId::one().as_uuid(),
            user_id: *actor.as_uuid(),
            org_wide: true,
            branch_ids: Vec::new(),
        };
        let store = PgAttendanceStore::new(runtime_role_pool(&pool).await);
        let command = CloseMonth {
            month: "2026-07".into(),
            branch_scope: None,
            attest: true,
        };
        let receipt = store.close_month(&caller, command.clone()).await.unwrap();
        let workplace = CloseMonth {
            branch_scope: Some(*branch.as_uuid()),
            ..command
        };
        let preflight = store.close_checks(&caller, &workplace).await.unwrap();
        assert!(!preflight.can_close);
        assert!(
            !preflight
                .checks
                .iter()
                .find(|c| c.key == "not_already_closed")
                .unwrap()
                .ok
        );
        assert!(matches!(
            store.close_month(&caller, workplace).await,
            Err(AttendanceStoreError::CloseBlocked)
        ));
        let rows = store
            .list_closes(&caller, Some(*branch.as_uuid()), receipt.month)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, receipt.id);
        assert_eq!(rows[0].branch_id, None);
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM attendance_month_closes WHERE org_id=$1")
                .bind(caller.org_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 1);
    })
    .await;
}
