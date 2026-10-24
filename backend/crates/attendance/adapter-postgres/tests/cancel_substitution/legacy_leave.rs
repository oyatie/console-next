// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
#[path = "../../../../../test-support/person_fixtures.rs"]
mod person_fixtures;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_assignment_rechecks_after_leave_commit(owner_pool: PgPool) {
    scope_org(OrgId::one(), async move {
        let branch = seed_branch(&owner_pool, "attendance-legacy-race", "operations").await;
        let provisioner = seed_user(&owner_pool, "Employee Directory Provisioner", "SUPER_ADMIN", branch).await;
        let actor = seed_user(&owner_pool, "Attendance Manager", "ADMIN", branch).await;
        for user in [provisioner, actor] {
            person_fixtures::bind_user_to_distinct_person(&owner_pool, user).await;
        }
        let worker = seed_employee(&owner_pool, branch, provisioner, "Legacy worker").await;
        let day = OffsetDateTime::now_utc().date() + Duration::days(12);
        let writer_pool = one_connection_pool(
            &owner_pool,
            "attendance-legacy-leave-writer",
            PoolRole::LeaveDefiner,
        )
        .await;
        let reader = one_connection_pool(
            &owner_pool,
            "attendance-legacy-insert-reader",
            PoolRole::Runtime,
        )
        .await;
        let reader_session = reader_session(&reader).await;
        let mut leave = writer_pool.begin().await.unwrap();
        let writer_session = writer_session(&mut leave).await;
        sqlx::query("SELECT set_config('app.current_org', $1, false)")
            .bind(OrgId::one().as_uuid().to_string())
            .execute(&mut *leave)
            .await
            .unwrap();
        sqlx::query("SELECT public.console_employee_day_eligibility_lock($1,$2,$3)")
            .bind(*OrgId::one().as_uuid())
            .bind(worker)
            .bind(day)
            .execute(&mut *leave)
            .await
            .unwrap();
        sqlx::query("INSERT INTO leave_requests (org_id,branch_id,requester_user_id,subject_employee_id,leave_type,days,start_date,end_date,status,decided_by,decided_at,charge_state,charge_review_reasons,charge_units) VALUES ($1,$2,$3,$4,'annual',1,$5,$5,'approved',$6,statement_timestamp(),'legacy_unverified',ARRAY[]::TEXT[],1)")
            .bind(*OrgId::one().as_uuid())
            .bind(*branch.as_uuid())
            .bind(*provisioner.as_uuid())
            .bind(worker)
            .bind(day)
            .bind(*actor.as_uuid())
            .execute(&mut *leave)
            .await
            .unwrap();
        let legacy = tokio::spawn(async move { sqlx::query("INSERT INTO attendance_substitutions (org_id,site,branch_id,role,cover_date,from_minutes,to_minutes,covered_employee_id,reason_kind,worker_employee_id,worker_name,worker_type,created_by,idempotency_key,request_fingerprint) VALUES ($1,'site',$2,'role',$3,480,960,$4,'OTHER',$4,'legacy','REGULAR',$5,'legacy-recheck',$6)").bind(*OrgId::one().as_uuid()).bind(*branch.as_uuid()).bind(day).bind(worker).bind(*actor.as_uuid()).bind("a".repeat(64)).execute(&reader).await });
        wait_for_advisory_lock_waiter(&owner_pool, &reader_session, &writer_session).await;
        leave.commit().await.unwrap();
        let error = legacy.await.unwrap().expect_err("legacy trigger rechecks committed leave");
        let database = error.as_database_error().expect("legacy insert must fail with a database guard");
        assert_eq!(database.code().as_deref(), Some("23514"));
        assert_eq!(database.message(), "attendance_substitutions_worker_eligibility_guard");
    }).await;
}
