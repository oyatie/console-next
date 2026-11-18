// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn home_branch_requires_employee_old_target_and_tenant_authority(owner: PgPool) {
    let org = OrgId::new();
    let branch = BranchId::new();
    let requester = UserId::new();
    let employee = Uuid::new_v4();
    seed_subject(&owner, org, branch, requester, employee).await;
    let target: Uuid = sqlx::query_scalar(
        "INSERT INTO branches(org_id,region_id,name) SELECT org_id,region_id,'Target' FROM branches WHERE id=$1 RETURNING id",
    ).bind(branch.as_uuid()).fetch_one(&owner).await.unwrap();
    let entity = Uuid::new_v4();
    sqlx::query("INSERT INTO legal_entities(org_id,id,needs_confirmation,created_change_mode) VALUES($1,$2,true,'MIGRATION')")
        .bind(org.as_uuid()).bind(entity).execute(&owner).await.unwrap();
    let workplaces = [Uuid::new_v4(), Uuid::new_v4()];
    for (workplace, branch) in workplaces.into_iter().zip([*branch.as_uuid(), target]) {
        sqlx::query("INSERT INTO workplaces(org_id,id,legal_entity_id,default_branch_id,needs_confirmation,created_change_mode) VALUES($1,$2,$3,$4,true,'MIGRATION')")
            .bind(org.as_uuid()).bind(workplace).bind(entity).bind(branch).execute(&owner).await.unwrap();
    }
    let maker = UserId::new();
    seed_branch_admin(&owner, org, branch, maker).await;
    let definer = leave_definer_role_pool(&owner).await;
    sqlx::query("SELECT set_config('app.current_org',$1,false)")
        .bind(org.to_string())
        .execute(&definer)
        .await
        .unwrap();
    let runtime = runtime_role_pool(&owner).await;
    let store = PgLeaveStore::new(runtime.clone(), Arc::new(PgInboxStore::new(runtime)))
        .with_leave_command_pool(leave_command_role_pool(&owner).await);

    // Isolate old-branch authority after placement has already moved to the target workplace.
    for (label, placed, granted, home, tenant_grant, allowed) in [
        ("target branch", 0, 0, Some(*branch.as_uuid()), false, false),
        (
            "employee scope",
            0,
            1,
            Some(*branch.as_uuid()),
            false,
            false,
        ),
        ("old branch", 1, 1, Some(*branch.as_uuid()), false, false),
        ("first assignment", 1, 1, None, false, false),
        ("tenant first assignment", 1, 1, None, true, true),
    ] {
        let employee = Uuid::new_v4();
        sqlx::query("INSERT INTO employees(id,org_id,company,name,source_filename,source_sheet,source_row,source_key,home_branch_id) VALUES($1,$2,'Test','Routing subject','test.xlsx','employees',1,$3,$4)")
            .bind(employee).bind(org.as_uuid()).bind(employee.to_string()).bind(home).execute(&definer).await.unwrap();
        sqlx::query("INSERT INTO employment_assignments(org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,actor_id,command_id) VALUES($1,$2,$3,$4,'2020-01-01','HIRE',$5,$6)")
            .bind(org.as_uuid()).bind(employee).bind(entity).bind(workplaces[placed]).bind(requester.as_uuid()).bind(Uuid::new_v4()).execute(&owner).await.unwrap();
        let actor = UserId::new();
        seed_branch_admin(&owner, org, branch, actor).await;
        sqlx::query("UPDATE users SET roles=ARRAY['MEMBER'] WHERE id=$1")
            .bind(actor.as_uuid())
            .execute(&owner)
            .await
            .unwrap();
        sqlx::query("DELETE FROM user_branches WHERE user_id=$1")
            .bind(actor.as_uuid())
            .execute(&owner)
            .await
            .unwrap();
        grant(
            &owner,
            org,
            actor,
            maker,
            (!tenant_grant).then_some(workplaces[granted]),
            None,
        )
        .await;
        let before = routing(&owner, employee).await;
        let result = console_platform_request_context::scope_org(
            org,
            store.set_employee_home_branch(
                employee,
                target,
                before.1,
                actor,
                console_kernel_core::TraceContext::generate(),
            ),
        )
        .await;
        if allowed {
            assert_eq!(result.unwrap().home_branch_id, target, "{label}");
            assert_eq!(routing(&owner, employee).await.0, Some(target));
        } else {
            assert_eq!(
                result.unwrap_err().kind(),
                console_kernel_core::ErrorKind::Forbidden,
                "{label}"
            );
            assert_eq!(
                routing(&owner, employee).await,
                before,
                "{label} wrote routing or audit"
            );
        }
    }
}

async fn routing(owner: &PgPool, employee: Uuid) -> (Option<Uuid>, OffsetDateTime, i64) {
    sqlx::query_as("SELECT home_branch_id,updated_at,(SELECT count(*) FROM audit_events WHERE target_id=$1::text AND action='employee.home_branch_set') FROM employees WHERE id=$1")
        .bind(employee).fetch_one(owner).await.unwrap()
}
