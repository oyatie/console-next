//! Missing classification follows the existing unavailable-profile refusal.
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn employee_without_profile_is_not_a_candidate_or_assignable(owner_pool: PgPool) {
    unavailable_profile_is_refused(owner_pool, true).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn minimum_registration_without_classification_is_not_a_candidate_or_assignable(
    owner_pool: PgPool,
) {
    unavailable_profile_is_refused(owner_pool, false).await;
}

async fn unavailable_profile_is_refused(owner_pool: PgPool, delete_profile: bool) {
    scope_org(OrgId::one(), async move {
        let branch = seed_branch(&owner_pool, "attendance-profile-required", "operations").await;
        let provisioner = seed_user(
            &owner_pool,
            "Employee Directory Provisioner",
            "SUPER_ADMIN",
            branch,
        )
        .await;
        let actor = seed_user(&owner_pool, "Attendance Manager", "ADMIN", branch).await;
        let covered = seed_employee(&owner_pool, branch, provisioner, "Covered employee").await;
        let worker =
            seed_employee(&owner_pool, branch, provisioner, "Profile missing worker").await;
        let sql = if delete_profile {
            "DELETE FROM employee_employment_profiles WHERE employee_id=$1"
        } else {
            "UPDATE employee_employment_profiles SET employment_type=NULL WHERE employee_id=$1"
        };
        sqlx::query(sql)
            .bind(worker)
            .execute(&owner_pool)
            .await
            .unwrap();
        let caller = CallerScope {
            org_id: *OrgId::one().as_uuid(),
            user_id: *actor.as_uuid(),
            branch_ids: vec![*branch.as_uuid()],
            org_wide: false,
        };
        let store = PgAttendanceStore::new(runtime_role_pool(&owner_pool).await);
        let window = SubstitutionWindow::new(
            OffsetDateTime::now_utc().date() + Duration::days(5),
            480,
            960,
        )
        .unwrap();
        let candidates = store
            .list_substitution_candidates(
                &caller,
                SubstitutionCandidateQuery::new(
                    *branch.as_uuid(),
                    covered,
                    window.clone(),
                    None,
                    None,
                    None,
                )
                .unwrap(),
            )
            .await
            .unwrap();
        assert!(candidates.items.is_empty());
        assert_eq!(candidates.total, 0);
        let error = store
            .assign_substitute(
                &caller,
                assignment_command(
                    window,
                    *branch.as_uuid(),
                    covered,
                    worker,
                    "attendance-profile-missing-0001",
                ),
            )
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            console_attendance_adapter_postgres::AttendanceStoreError::Conflict
        ));
        let rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM attendance_substitutions WHERE worker_employee_id=$1",
        )
        .bind(worker)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
        let audits: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_events WHERE action='attendance.substitution.assign'",
        )
        .fetch_one(&owner_pool)
        .await
        .unwrap();
        assert_eq!((rows, audits), (0, 0));
    })
    .await;
}
