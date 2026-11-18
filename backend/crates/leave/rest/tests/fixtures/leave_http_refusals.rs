// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn leave_sql_guards_validate_active_tenant_identity_only(owner: PgPool) {
    let org = OrgId::new();
    let branch = BranchId::new();
    let actor = UserId::new();
    seed_subject(&owner, org, branch, actor, Uuid::new_v4()).await;
    let definer = leave_definer_role_pool(&owner).await;
    sqlx::query("SELECT set_config('app.current_org',$1,false)")
        .bind(org.to_string())
        .execute(&definer)
        .await
        .unwrap();
    for guard in [
        "SELECT leave_api.assert_manager($1,$2,NULL)",
        "SELECT leave_api.assert_org_admin($1,$2)",
    ] {
        sqlx::query(guard)
            .bind(org.as_uuid())
            .bind(actor.as_uuid())
            .execute(&definer)
            .await
            .unwrap();
        for invalid_actor in [None, Some(Uuid::new_v4())] {
            let error = sqlx::query(guard)
                .bind(org.as_uuid())
                .bind(invalid_actor)
                .execute(&definer)
                .await
                .unwrap_err();
            assert_eq!(
                error.as_database_error().unwrap().code().as_deref(),
                Some("42501")
            );
        }
        let error = sqlx::query(guard)
            .bind(Uuid::new_v4())
            .bind(actor.as_uuid())
            .execute(&definer)
            .await
            .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("42501")
        );
        sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
            .bind(actor.as_uuid())
            .execute(&owner)
            .await
            .unwrap();
        let error = sqlx::query(guard)
            .bind(org.as_uuid())
            .bind(actor.as_uuid())
            .execute(&definer)
            .await
            .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("42501")
        );
        sqlx::query("UPDATE users SET is_active=true WHERE id=$1")
            .bind(actor.as_uuid())
            .execute(&owner)
            .await
            .unwrap();
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unauthorized_decisions_hide_status_version_and_existence(owner: PgPool) {
    let org = OrgId::new();
    let branch = BranchId::new();
    let requester = UserId::new();
    let employee = Uuid::new_v4();
    seed_subject(&owner, org, branch, requester, employee).await;
    let actor = UserId::new();
    seed_branch_admin(&owner, org, branch, actor).await;
    sqlx::query("UPDATE users SET roles=ARRAY['MEMBER'] WHERE id=$1")
        .bind(actor.as_uuid())
        .execute(&owner)
        .await
        .unwrap();
    person_fixtures::bind_user_to_distinct_person(&owner, actor).await;
    let auth = test_auth_with_roles(&owner, actor, org, vec![branch], vec!["MEMBER"]).await;
    let runtime = runtime_role_pool(&owner).await;
    let service = router(LeaveRestState::new(
        PgLeaveStore::new(runtime.clone(), Arc::new(PgInboxStore::new(runtime)))
            .with_leave_command_pool(leave_command_role_pool(&owner).await),
        Some(auth.verifier),
    ));
    let definer = leave_definer_role_pool(&owner).await;
    sqlx::query("SELECT set_config('app.current_org',$1,false)")
        .bind(org.to_string())
        .execute(&definer)
        .await
        .unwrap();
    let mut ids = Vec::new();
    for status in ["pending", "approved"] {
        let id: Uuid = sqlx::query_scalar("INSERT INTO leave_requests(org_id,branch_id,requester_user_id,subject_employee_id,leave_type,days,start_date,end_date,status,charge_state,charge_units,charge_review_reasons,decided_by,decided_at) VALUES($1,$2,$3,$4,'annual',1,'2026-10-01','2026-10-01',$5,CASE WHEN $5='approved' THEN 'legacy_unverified' ELSE 'review_required' END,CASE WHEN $5='approved' THEN 1 ELSE NULL END,CASE WHEN $5='approved' THEN ARRAY[]::text[] ELSE ARRAY['missing_calendar'] END,CASE WHEN $5='approved' THEN $6 ELSE NULL END,CASE WHEN $5='approved' THEN now() ELSE NULL END) RETURNING id")
            .bind(org.as_uuid()).bind(branch.as_uuid()).bind(requester.as_uuid()).bind(employee).bind(status).bind(actor.as_uuid()).fetch_one(&definer).await.unwrap();
        ids.push(id);
    }
    let before: Value =
        sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM leave_requests r")
            .fetch_one(&definer)
            .await
            .unwrap();
    // Refusal receipts stay auditable; no leave mutation may be recorded.
    let before_audits: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND actor=$2 AND target_type='leave_request'")
            .bind(org.as_uuid())
            .bind(actor.as_uuid())
            .fetch_one(&owner)
            .await
            .unwrap();
    ids.push(Uuid::new_v4());
    for id in ids {
        for version in ["v1", "v2"] {
            for expected in [1, 999] {
                let response = request_json(
                    service.clone(),
                    "POST",
                    &format!("/api/{version}/leave/requests/{id}/decide"),
                    &auth.token,
                    Some(if version == "v1" {
                        json!({"decision":"approve"})
                    } else {
                        json!({"decision":"approve","expected_version":expected})
                    }),
                )
                .await;
                assert_eq!(
                    response.status,
                    StatusCode::FORBIDDEN,
                    "{version} {id} {expected}: {}",
                    response.body
                );
                assert_eq!(response.body["error"]["code"], "forbidden");
            }
        }
    }
    let after: Value =
        sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM leave_requests r")
            .fetch_one(&definer)
            .await
            .unwrap();
    assert_eq!(before, after);
    let audits: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND actor=$2 AND target_type='leave_request'")
            .bind(org.as_uuid())
            .bind(actor.as_uuid())
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(audits, before_audits);
    let balance: (f64, f64) = sqlx::query_as(
        "SELECT leave_used::float8,leave_remaining::float8 FROM employees WHERE id=$1",
    )
    .bind(employee)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(balance, (2.0, 13.0));
}
