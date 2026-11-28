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
        let entity: uuid::Uuid = sqlx::query_scalar("INSERT INTO legal_entities(org_id,id,needs_confirmation,created_change_mode)
            VALUES ($1,gen_random_uuid(),true,'MIGRATION') RETURNING id").bind(caller.org_id).fetch_one(&pool).await.unwrap();
        let group: uuid::Uuid = sqlx::query_scalar(r#"INSERT INTO pay_groups(org_id,id,legal_entity_id,name,pay_date_rule,base_period,variable_period,proration,channel,sensitive,pay_basis_allowed)
             VALUES ($1,gen_random_uuid(),$2,'Monthly','{"day":"LAST_DAY","month_offset":0,"non_business_day":"PREVIOUS"}',
             '{"start_day":"FIRST","month_offset":0}','{"start_day":"FIRST","month_offset":0}','CALENDAR_DAYS','ATTESTATION_ONLY',false,ARRAY['MONTHLY']) RETURNING id"#)
            .bind(caller.org_id).bind(entity).fetch_one(&pool).await.unwrap();
        sqlx::query("INSERT INTO period_locks(org_id,domain,pay_group_id,period_start,period_end,reason)
             VALUES ($1,'payroll',$2,'2026-06-01','2026-06-30','Group freeze')")
            .bind(caller.org_id).bind(group).execute(&pool).await.unwrap();
        let scoped = CloseMonth { month: "2026-06".into(), ..command.clone() };
        assert!(matches!(store.close_month(&caller, scoped).await, Err(AttendanceStoreError::Conflict)));
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
