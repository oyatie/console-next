use super::person_accounts::person_fixtures;
use super::*;
use console_platform_request_context::scope_org;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn same_person_accounts_cannot_decide_leave(owner_pool: PgPool) {
    let org = OrgId::one();
    let org_uuid = *org.as_uuid();
    let rt = runtime_role_pool(&owner_pool).await;
    let command = leave_command_role_pool(&owner_pool).await;
    let store = test_store(&rt, &command);
    let branch = seed_branch(&owner_pool, org_uuid).await;
    let maker = seed_user(&owner_pool, org_uuid).await;
    let employee = seed_employee(&owner_pool, org_uuid, 15.0, 0.0, 15.0).await;
    link_user_to_employee_and_branch(&owner_pool, org_uuid, maker, employee, branch).await;
    let person: Uuid = sqlx::query_scalar(
        "SELECT person_id FROM employee_person_bindings WHERE org_id=$1 AND employee_id=$2",
    )
    .bind(org_uuid)
    .bind(employee)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    let same = seed_user(&owner_pool, org_uuid).await;
    person_fixtures::bind_user_to_person(&owner_pool, same, person).await;
    link_user_to_branch(&owner_pool, org_uuid, same, branch).await;
    let same_person_alias = seed_user(&owner_pool, org_uuid).await;
    person_fixtures::bind_user_to_person(&owner_pool, same_person_alias, person).await;
    let request = scope_org(
        org,
        store.create_request(create_cmd(branch, maker, employee, 1.0)),
    )
    .await
    .unwrap();
    assert_ne!(maker, same);
    let before = snapshot(&owner_pool, *request.id.as_uuid()).await;
    let unknown = console_kernel_core::UserId::new();
    for checker in [maker, same, same_person_alias, unknown] {
        for decision in [LeaveDecision::Approve, LeaveDecision::TimeChange] {
            let err = scope_org(
                org,
                store.decide(decide_cmd(request.id, checker, BranchScope::All, decision)),
            )
            .await
            .unwrap_err();
            assert_eq!(err.kind(), ErrorKind::Forbidden);
            assert!(
                matches!(err, console_leave_adapter_postgres::PgLeaveError::Domain(ref e)
                if e.code == Some("leave_decide_requester_forbidden"))
            );
            assert_eq!(snapshot(&owner_pool, *request.id.as_uuid()).await, before);
        }
    }
}

async fn snapshot(
    pool: &PgPool,
    request: Uuid,
) -> (serde_json::Value, serde_json::Value, i64, i64) {
    sqlx::query_as("SELECT to_jsonb(r), (SELECT jsonb_build_object('used',e.leave_used,'remaining',e.leave_remaining) FROM employees e WHERE e.id=r.subject_employee_id), (SELECT count(*) FROM audit_events), (SELECT count(*) FROM inbox_docs) FROM leave_requests r WHERE id=$1")
        .bind(request).fetch_one(pool).await.unwrap()
}
