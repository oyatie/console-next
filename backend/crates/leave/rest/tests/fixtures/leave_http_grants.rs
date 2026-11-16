// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_granted_approver_is_confined_to_employee_workplace(owner: PgPool) {
    let org = OrgId::new();
    let branch = BranchId::new();
    let requester = UserId::new();
    let employee = Uuid::new_v4();
    seed_subject(&owner, org, branch, requester, employee).await;
    let entity = Uuid::new_v4();
    let workplaces = [Uuid::new_v4(), Uuid::new_v4()];
    sqlx::query("INSERT INTO legal_entities(org_id,id,biz_kind,crn,needs_confirmation,created_change_mode) VALUES($1,$2,'CORPORATION','0002110006241',true,'MIGRATION')")
        .bind(org.as_uuid()).bind(entity).execute(&owner).await.unwrap();
    for (index, workplace) in workplaces.into_iter().enumerate() {
        sqlx::query("INSERT INTO workplaces(org_id,id,legal_entity_id,default_branch_id,needs_confirmation,created_change_mode) VALUES($1,$2,$3,$4,true,'MIGRATION')")
            .bind(org.as_uuid()).bind(workplace).bind(entity).bind((index == 0).then_some(*branch.as_uuid())).execute(&owner).await.unwrap();
    }
    sqlx::query("INSERT INTO employment_assignments(org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,actor_id,command_id) VALUES($1,$2,$3,$4,'2020-01-01','HIRE',$5,$6)")
        .bind(org.as_uuid()).bind(employee).bind(entity).bind(workplaces[0]).bind(requester.as_uuid()).bind(Uuid::new_v4()).execute(&owner).await.unwrap();
    let definer = leave_definer_role_pool(&owner).await;
    sqlx::query("SELECT set_config('app.current_org',$1,false)")
        .bind(org.to_string())
        .execute(&definer)
        .await
        .unwrap();
    let resolver = UserId::new();
    seed_branch_admin(&owner, org, branch, resolver).await;
    let runtime = runtime_role_pool(&owner).await;
    let store = PgLeaveStore::new(runtime.clone(), Arc::new(PgInboxStore::new(runtime)))
        .with_leave_command_pool(leave_command_role_pool(&owner).await);
    for (role, granted_workplace, allowed) in [
        ("MEMBER", Some(workplaces[0]), true),
        ("MEMBER", Some(workplaces[1]), false),
        ("MEMBER", None, false),
        ("ADMIN", None, true),
    ] {
        let approver = UserId::new();
        seed_branch_admin(&owner, org, branch, approver).await;
        sqlx::query("UPDATE users SET roles=ARRAY[$2] WHERE id=$1")
            .bind(approver.as_uuid())
            .bind(role)
            .execute(&owner)
            .await
            .unwrap();
        person_fixtures::bind_user_to_distinct_person(&owner, approver).await;
        if let Some(workplace) = granted_workplace {
            grant(&owner, org, approver, resolver, workplace).await;
            if workplace == workplaces[0] {
                sqlx::query("DELETE FROM user_branches WHERE user_id=$1")
                    .bind(approver.as_uuid())
                    .execute(&owner)
                    .await
                    .unwrap();
            }
        }
        let auth = test_auth_with_roles(&owner, approver, org, vec![branch], vec![role]).await;
        let service = router(LeaveRestState::new(store.clone(), Some(auth.verifier)));
        let charge_id: Uuid = sqlx::query_scalar("INSERT INTO leave_requests(org_id,branch_id,requester_user_id,subject_employee_id,leave_type,days,start_date,end_date,status) VALUES($1,$2,$3,$4,'annual',1,'2026-10-01','2026-10-01','pending') RETURNING id")
            .bind(org.as_uuid()).bind(branch.as_uuid()).bind(requester.as_uuid()).bind(employee).fetch_one(&definer).await.unwrap();
        let charge = request_json(service.clone(), "POST", &format!("/api/v2/leave/requests/{charge_id}/charge-resolution"), &auth.token, Some(json!({
            "expected_version": 1,
            "date_charges": [{"date":"2026-10-01","obligation":{"kind":"scheduled","minutes":480},"charge_units":"1"}],
            "calendar_revision_ref":{"kind":"manual","reference":"calendar","revision":"1"},
            "policy_revision_ref":{"kind":"manual","reference":"policy","revision":"1"}
        }))).await;
        assert_eq!(
            charge.status,
            if allowed {
                StatusCode::OK
            } else {
                StatusCode::FORBIDDEN
            },
            "charge {role} {granted_workplace:?}: {}",
            charge.body
        );
        let expected: OffsetDateTime =
            sqlx::query_scalar("SELECT updated_at FROM employees WHERE id=$1")
                .bind(employee)
                .fetch_one(&owner)
                .await
                .unwrap();
        let home = console_platform_request_context::scope_org(
            org,
            store.set_employee_home_branch(
                employee,
                *branch.as_uuid(),
                expected,
                approver,
                console_kernel_core::TraceContext::generate(),
            ),
        )
        .await;
        assert_eq!(
            home.is_ok(),
            allowed,
            "home branch {role} {granted_workplace:?}: {home:?}"
        );
        if !allowed {
            assert_eq!(
                home.unwrap_err().kind(),
                console_kernel_core::ErrorKind::Forbidden
            );
        }
        for version in ["v1", "v2"] {
            let id: Uuid = sqlx::query_scalar("INSERT INTO leave_requests(org_id,branch_id,requester_user_id,subject_employee_id,leave_type,days,start_date,end_date,status) VALUES($1,$2,$3,$4,'annual',1,'2026-10-01','2026-10-01','pending') RETURNING id")
                .bind(org.as_uuid()).bind(branch.as_uuid()).bind(requester.as_uuid()).bind(employee).fetch_one(&definer).await.unwrap();
            let resolved = console_platform_request_context::scope_org(
                org,
                store.resolve_charge(console_leave_application::ResolveLeaveChargeCommand {
                    request_id: console_kernel_core::LeaveRequestId::from_uuid(id),
                    resolver,
                    branch_scope: console_kernel_core::BranchScope::All,
                    expected_version: 1,
                    date_charges: vec![console_leave_domain::LeaveDateCharge {
                        date: time::macros::date!(2026 - 10 - 01),
                        obligation: console_leave_domain::WorkObligation::Scheduled {
                            minutes: 480,
                        },
                        units: console_leave_domain::LeaveUnits::ONE_DAY,
                    }],
                    calendar_revision_ref: console_leave_domain::SourceRevisionRef::new(
                        "manual", "calendar", "1",
                    )
                    .unwrap(),
                    policy_revision_ref: console_leave_domain::SourceRevisionRef::new(
                        "manual", "policy", "1",
                    )
                    .unwrap(),
                    supporting_source_refs: vec![],
                    trace: console_kernel_core::TraceContext::generate(),
                    occurred_at: OffsetDateTime::now_utc(),
                }),
            )
            .await
            .unwrap();
            let response = request_json(
                service.clone(),
                "POST",
                &format!("/api/{version}/leave/requests/{id}/decide"),
                &auth.token,
                Some(if version == "v1" {
                    json!({"decision":"approve"})
                } else {
                    json!({"decision":"approve","expected_version":resolved.request_version})
                }),
            )
            .await;
            assert_eq!(
                response.status,
                if allowed {
                    StatusCode::OK
                } else {
                    StatusCode::FORBIDDEN
                },
                "{role} {granted_workplace:?} {version}: {}",
                response.body
            );
            let (status, decider): (String, Option<Uuid>) =
                sqlx::query_as("SELECT status,decided_by FROM leave_requests WHERE id=$1")
                    .bind(id)
                    .fetch_one(&owner)
                    .await
                    .unwrap();
            assert_eq!(status, if allowed { "approved" } else { "pending" });
            assert_eq!(decider, allowed.then_some(*approver.as_uuid()));
        }
    }
}

async fn grant(pool: &PgPool, org: OrgId, actor: UserId, maker: UserId, workplace: Uuid) {
    let role = Uuid::new_v4();
    let name = format!("Leave approver {role}");
    sqlx::query("INSERT INTO access_roles(org_id,id,name_ko,status,version,created_by) VALUES($1,$2,$4,'ACTIVE',1,$3)")
        .bind(org.as_uuid()).bind(role).bind(maker.as_uuid()).bind(&name).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions(org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES($1,$2,1,$4,'ACTIVE','SETUP',$3)")
        .bind(org.as_uuid()).bind(role).bind(maker.as_uuid()).bind(&name).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines(org_id,role_id,version,domain,levels) VALUES($1,$2,1,'hr_basic',ARRAY['edit'])")
        .bind(org.as_uuid()).bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_grants(org_id,account_id,role_id,scope_kind,workplace_id,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES($1,$2,$3,'WORKPLACE',$4,now()-interval '1 day',true,'SETUP','TEST',$5)")
        .bind(org.as_uuid()).bind(actor.as_uuid()).bind(role).bind(workplace).bind(maker.as_uuid()).execute(pool).await.unwrap();
}

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
