// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{seed_attendance_record, seed_employee};
use console_attendance_adapter_postgres::PgAttendanceStore;
use console_attendance_application::{CallerScope, ReadOwnWeek52, SelfAttendanceScope};
use console_kernel_core::OrgId;
use console_platform_request_context::scope_org;
use console_platform_test_support::{runtime_role_pool, seed_branch, seed_user};
use sqlx::PgPool;
use time::{Duration, UtcOffset, macros::date};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn weekly_limits_drive_both_projections_and_missing_rows_are_unknown(owner: PgPool) {
    scope_org(OrgId::one(), async move {
        let branch = seed_branch(&owner, "weekly-limits", "operations").await;
        let actor = seed_user(&owner, "Weekly monitor", "SUPER_ADMIN", branch).await;
        let employee = seed_employee(&owner, branch, actor, "Weekly employee").await;
        sqlx::query("UPDATE users SET employee_id=$1 WHERE id=$2")
            .bind(employee).bind(actor.as_uuid()).execute(&owner).await.unwrap();
        let monday = date!(2026 - 10 - 26);
        let start = monday.with_hms(9, 0, 0).unwrap().assume_offset(UtcOffset::from_hms(9, 0, 0).unwrap());
        for day in 0..5 {
            let start = start + Duration::days(day);
            seed_attendance_record(&owner, employee, *actor.as_uuid(), "CLOCK_IN", start, "CLOCKED_IN").await;
            seed_attendance_record(&owner, employee, *actor.as_uuid(), "CLOCK_OUT", start+Duration::hours(9), "OFF_DUTY").await;
        }
        let store = PgAttendanceStore::new(runtime_role_pool(&owner).await);
        let caller = CallerScope { org_id: *OrgId::one().as_uuid(), user_id: *actor.as_uuid(), branch_ids: vec![*branch.as_uuid()], org_wide: true };
        let own = SelfAttendanceScope { org_id: caller.org_id, user_id: caller.user_id };
        for (warn, expected) in [(None, "OK"), (Some(45), "WARN")] {
            if let Some(warn) = warn {
                let mut tx = owner.begin().await.unwrap();
                sqlx::query("SET LOCAL session_replication_role=replica").execute(&mut *tx).await.unwrap();
                sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,effective_from,set_by,reason_code,direction) VALUES($1,'attendance.week52.warn_hours',$2,now(),$3,'X','tighten')")
                    .bind(caller.org_id).bind(serde_json::json!(warn)).bind(caller.user_id).execute(&mut *tx).await.unwrap();
                tx.commit().await.unwrap();
            }
            let manager = store.week52_inputs(&caller, monday, Some(*branch.as_uuid())).await.unwrap();
            assert_eq!(manager[0].current_hours, 45.0);
            assert_eq!(serde_json::to_value(manager[0].tone).unwrap(), expected);
            let own = store.read_own_week52(own, ReadOwnWeek52::new(monday).unwrap()).await.unwrap().unwrap();
            assert_eq!(serde_json::to_value(own.tone).unwrap(), expected);
        }
        // Change only the register and raw hours: both read paths must derive Danger.
        let saturday = start + Duration::days(5);
        seed_attendance_record(&owner, employee, *actor.as_uuid(), "CLOCK_IN", saturday, "CLOCKED_IN").await;
        seed_attendance_record(&owner, employee, *actor.as_uuid(), "CLOCK_OUT", saturday + Duration::hours(5), "OFF_DUTY").await;
        sqlx::query("UPDATE statutory_rules SET value_num=10 WHERE code='WEEKLY_OVERTIME_MAX_HOURS' AND effective_from='2026-10-08'")
            .execute(&owner).await.unwrap();
        let manager = store.week52_inputs(&caller, monday, Some(*branch.as_uuid())).await.unwrap();
        assert_eq!(serde_json::to_value(manager[0].tone).unwrap(), "DANGER");
        let projection = store.read_own_week52(own, ReadOwnWeek52::new(monday).unwrap()).await.unwrap().unwrap();
        assert_eq!(serde_json::to_value(projection.tone).unwrap(), "DANGER");
        let after_coverage = date!(2028 - 01 - 03);
        let manager = store.week52_inputs(&caller, after_coverage, Some(*branch.as_uuid())).await.unwrap();
        assert_eq!(manager[0].current_hours, 0.0);
        assert_eq!(serde_json::to_value(manager[0].tone).unwrap(), "UNKNOWN");
        let projection = store.read_own_week52(own, ReadOwnWeek52::new(after_coverage).unwrap()).await.unwrap().unwrap();
        assert_eq!(projection.current_hours, 0.0);
        assert_eq!(serde_json::to_value(projection.tone).unwrap(), "UNKNOWN");
        for (code, value, restore) in [("WEEKLY_STANDARD_HOURS", 0_i64, 40_i64), ("WEEKLY_OVERTIME_MAX_HOURS", 4, 12)] {
            sqlx::query("UPDATE statutory_rules SET value_num=$2 WHERE code=$1 AND effective_from='2026-10-08'")
                .bind(code).bind(value).execute(&owner).await.unwrap();
            let manager = store.week52_inputs(&caller, monday, Some(*branch.as_uuid())).await.unwrap();
            assert_eq!(serde_json::to_value(manager[0].tone).unwrap(), "UNKNOWN");
            let projection = store.read_own_week52(own, ReadOwnWeek52::new(monday).unwrap()).await.unwrap().unwrap();
            assert_eq!(serde_json::to_value(projection.tone).unwrap(), "UNKNOWN");
            sqlx::query("UPDATE statutory_rules SET value_num=$2 WHERE code=$1 AND effective_from='2026-10-08'")
                .bind(code).bind(restore).execute(&owner).await.unwrap();
        }
        for code in ["WEEKLY_STANDARD_HOURS", "WEEKLY_OVERTIME_MAX_HOURS"] {
            let removed: Vec<serde_json::Value> = sqlx::query_scalar("DELETE FROM statutory_rules WHERE code=$1 RETURNING to_jsonb(statutory_rules.*)")
                .bind(code).fetch_all(&owner).await.unwrap();
            let manager = store.week52_inputs(&caller, monday, Some(*branch.as_uuid())).await.unwrap();
            assert_eq!(serde_json::to_value(manager[0].tone).unwrap(), "UNKNOWN");
            let projection = store.read_own_week52(own, ReadOwnWeek52::new(monday).unwrap()).await.unwrap().unwrap();
            assert_eq!(serde_json::to_value(projection.tone).unwrap(), "UNKNOWN");
            sqlx::query("INSERT INTO statutory_rules SELECT * FROM jsonb_populate_recordset(NULL::statutory_rules,$1)")
                .bind(serde_json::json!(removed)).execute(&owner).await.unwrap();
        }
    }).await;
}
