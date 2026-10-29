// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{seed_attendance_record, seed_employee};
use console_attendance_adapter_postgres::PgAttendanceStore;
use console_attendance_application::{CallerScope, ReadOwnWeek52, SelfAttendanceScope, Week52Tone};
use console_kernel_core::OrgId;
use console_platform_request_context::scope_org;
use console_platform_test_support::{runtime_role_pool, seed_branch, seed_user};
use sqlx::PgPool;
use time::{Duration, macros::date};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn weekly_policy_uses_week_start_and_preserves_known_danger(owner: PgPool) {
    scope_org(OrgId::one(), async move {
        let branch = seed_branch(&owner, "weekly-history", "operations").await;
        let actor = seed_user(&owner, "Weekly history", "SUPER_ADMIN", branch).await;
        let employee = seed_employee(&owner, branch, actor, "Weekly history").await;
        sqlx::query("UPDATE users SET employee_id=$1 WHERE id=$2")
            .bind(employee).bind(actor.as_uuid()).execute(&owner).await.unwrap();
        let monday = date!(2026 - 10 - 26);
        let start = monday.midnight().assume_utc();
        seed_attendance_record(&owner, employee, *actor.as_uuid(), "CLOCK_IN", start, "CLOCKED_IN").await;
        seed_attendance_record(&owner, employee, *actor.as_uuid(), "CLOCK_OUT", start + Duration::hours(44), "OFF_DUTY").await;
        // Exactly Monday 00:00 KST is in force; the next instant belongs to a later policy.
        let mut tx = owner.begin().await.unwrap();
        sqlx::query("SET LOCAL session_replication_role=replica").execute(&mut *tx).await.unwrap();
        sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,effective_from,set_by,reason_code,direction) VALUES ($1,'attendance.week52.warn_hours','45','2026-10-25T15:00:00Z',$2,'X','tighten'), ($1,'attendance.week52.warn_hours','40','2026-10-25T15:00:01Z',$2,'X','tighten')")
            .bind(OrgId::one().as_uuid()).bind(actor.as_uuid()).execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
        let store = PgAttendanceStore::new(runtime_role_pool(&owner).await);
        let caller = CallerScope { org_id: *OrgId::one().as_uuid(), user_id: *actor.as_uuid(), branch_ids: vec![*branch.as_uuid()], org_wide: true };
        let own = SelfAttendanceScope { org_id: caller.org_id, user_id: caller.user_id };
        for (standard, overtime, expected) in [
            (40_i64, 12_i64, Week52Tone::Ok),
            // Non-positive standard must be rejected independently of the warning guard.
            (0, 100, Week52Tone::Unknown),
            // Warning below standard must not report a safe week.
            (46, 12, Week52Tone::Unknown),
            // Warning equals/exceeds danger: unknown below, danger at the statutory line.
            (40, 5, Week52Tone::Unknown),
            (40, 4, Week52Tone::Danger),
        ] {
            sqlx::query("UPDATE statutory_rules SET value_num=CASE code WHEN 'WEEKLY_STANDARD_HOURS' THEN $1 ELSE $2 END WHERE code IN ('WEEKLY_STANDARD_HOURS','WEEKLY_OVERTIME_MAX_HOURS') AND effective_from='2026-10-08'")
                .bind(standard).bind(overtime).execute(&owner).await.unwrap();
            let manager = store.week52_inputs(&caller, monday, Some(*branch.as_uuid())).await.unwrap();
            assert_eq!(manager[0].tone, expected, "standard={standard}, overtime={overtime}");
            let projection = store.read_own_week52(own, ReadOwnWeek52::new(monday).unwrap()).await.unwrap().unwrap();
            assert_eq!(projection.tone, expected);
        }
        let thursday = start + Duration::days(3);
        seed_attendance_record(&owner, employee, *actor.as_uuid(), "CLOCK_IN", thursday, "CLOCKED_IN").await;
        seed_attendance_record(&owner, employee, *actor.as_uuid(), "CLOCK_OUT", thursday + Duration::hours(1), "OFF_DUTY").await;
        for (overtime, expected) in [(12_i64, Week52Tone::Warn), (5, Week52Tone::Danger), (4, Week52Tone::Danger)] {
            sqlx::query("UPDATE statutory_rules SET value_num=$1 WHERE code='WEEKLY_OVERTIME_MAX_HOURS' AND effective_from='2026-10-08'").bind(overtime).execute(&owner).await.unwrap();
            let manager = store.week52_inputs(&caller, monday, Some(*branch.as_uuid())).await.unwrap();
            assert_eq!(manager[0].tone, expected);
            assert_eq!(store.read_own_week52(own, ReadOwnWeek52::new(monday).unwrap()).await.unwrap().unwrap().tone, expected);
        }
    }).await;
}
