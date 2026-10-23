// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn v1_wire_shape_is_frozen_and_v2_requires_modern_exact_cas(owner_pool: PgPool) {
    let org = OrgId::new();
    let branch = BranchId::new();
    let requester = UserId::new();
    let decider = UserId::new();
    let employee = Uuid::new_v4();
    seed_subject(&owner_pool, org, branch, requester, employee).await;
    seed_branch_admin(&owner_pool, org, branch, decider).await;
    grant_console_rt(
        &owner_pool,
        &[
            "GRANT SELECT ON leave_requests TO console_rt",
            "GRANT SELECT ON users TO console_rt",
            "GRANT SELECT ON user_branches TO console_rt",
            "GRANT SELECT ON branches TO console_rt",
            "GRANT SELECT ON organizations TO console_rt",
        ],
    )
    .await;

    let v1_request = Uuid::new_v4();
    let modern_request = Uuid::new_v4();
    let definer_pool = leave_definer_role_pool(&owner_pool).await;
    sqlx::query("SELECT set_config('app.current_org', $1, false)")
        .bind(org.as_uuid().to_string())
        .execute(&definer_pool)
        .await
        .unwrap();
    for id in [v1_request, modern_request] {
        sqlx::query(
            "INSERT INTO leave_requests \
             (id, org_id, branch_id, requester_user_id, subject_employee_id, leave_type, days, \
              start_date, end_date, status) \
             VALUES ($1, $2, $3, $4, $5, 'annual', 1, DATE '2026-10-01', \
                     DATE '2026-10-01', 'pending')",
        )
        .bind(id)
        .bind(*org.as_uuid())
        .bind(*branch.as_uuid())
        .bind(*requester.as_uuid())
        .bind(employee)
        .execute(&definer_pool)
        .await
        .unwrap();
    }

    let auth = test_auth_with_roles(&owner_pool, decider, org, vec![branch], vec!["ADMIN"]).await;
    let runtime_pool = runtime_role_pool(&owner_pool).await;
    let command_pool = leave_command_role_pool(&owner_pool).await;
    let service = router(LeaveRestState::new(
        PgLeaveStore::new(
            runtime_pool.clone(),
            Arc::new(PgInboxStore::new(runtime_pool)),
        )
        .with_leave_command_pool(command_pool),
        Some(auth.verifier),
    ));

    // 근로기준법 §60: refusal is not a decision — even the frozen v1 route must
    // fail closed rather than mint a 'rejected' row.
    let refusal = request_json(
        service.clone(),
        "POST",
        &format!("/api/v1/leave/requests/{v1_request}/decide"),
        &auth.token,
        Some(json!({"decision": "reject", "comment": "v1 reject"})),
    )
    .await;
    assert_eq!(
        refusal.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        refusal.body
    );

    // An unavailable fact resolver still produces the stable refusal over HTTP.
    sqlx::query("REVOKE EXECUTE ON FUNCTION public.console_decision_people(UUID,UUID,UUID) FROM console_leave_cmd,console_leave_definer")
        .execute(&owner_pool).await.unwrap();
    let unknown = request_json(
        service.clone(),
        "POST",
        &format!("/api/v1/leave/requests/{v1_request}/decide"),
        &auth.token,
        Some(json!({"decision": "time_change", "comment": "신원 미확인"})),
    )
    .await;
    assert_eq!(unknown.status, StatusCode::FORBIDDEN);
    assert_eq!(
        unknown.body["error"]["code"],
        "leave.refuse.identity_unbound"
    );
    sqlx::query("GRANT EXECUTE ON FUNCTION public.console_decision_people(UUID,UUID,UUID) TO console_leave_cmd,console_leave_definer")
        .execute(&owner_pool).await.unwrap();

    person_fixtures::bind_user_to_distinct_person(&owner_pool, decider).await;
    // A verified decider keeps the deployed v1 wire shape.
    let versionless = request_json(
        service.clone(),
        "POST",
        &format!("/api/v1/leave/requests/{v1_request}/decide"),
        &auth.token,
        Some(json!({"decision": "time_change", "comment": "성수기 — 시기 변경 협의"})),
    )
    .await;
    assert_eq!(versionless.status, StatusCode::OK, "{:?}", versionless.body);
    assert_eq!(versionless.body["status"], "time_change_consult");
    let legacy_keys = versionless
        .body
        .as_object()
        .expect("v1 decision response must be an object")
        .keys()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        legacy_keys,
        std::collections::BTreeSet::from([
            "branch_id",
            "created_at",
            "days",
            "decided_at",
            "decided_by",
            "decision_comment",
            "end_date",
            "id",
            "leave_type",
            "reason",
            "requester_user_id",
            "start_date",
            "status",
            "subject_employee_id",
        ]),
        "v1 must remain byte-shape compatible with the deployed strict client"
    );

    let repeated = request_json(
        service.clone(),
        "POST",
        &format!("/api/v1/leave/requests/{v1_request}/decide"),
        &auth.token,
        Some(json!({"decision": "time_change", "comment": "repeated"})),
    )
    .await;
    assert_eq!(repeated.status, StatusCode::CONFLICT, "{:?}", repeated.body);
    assert_eq!(repeated.body["error"]["code"], "conflict");

    let stale_modern = request_json(
        service.clone(),
        "POST",
        &format!("/api/v2/leave/requests/{modern_request}/decide"),
        &auth.token,
        Some(json!({
            "expected_version": 99,
            "decision": "time_change",
            "comment": "stale"
        })),
    )
    .await;
    assert_eq!(
        stale_modern.status,
        StatusCode::CONFLICT,
        "{:?}",
        stale_modern.body
    );
    assert_eq!(
        stale_modern.body["error"]["code"],
        "leave_concurrent_modification"
    );

    let legacy_page = request_json(
        service.clone(),
        "GET",
        "/api/v1/leave/requests",
        &auth.token,
        None,
    )
    .await;
    assert_eq!(legacy_page.status, StatusCode::OK, "{:?}", legacy_page.body);
    assert!(legacy_page.body.get("next_cursor").is_none());
    assert!(
        legacy_page.body["items"][0]
            .get("request_version")
            .is_none()
    );

    let v2_page = request_json(service, "GET", "/api/v2/leave/requests", &auth.token, None).await;
    assert_eq!(v2_page.status, StatusCode::OK, "{:?}", v2_page.body);
    assert!(v2_page.body.get("next_cursor").is_some());
    assert!(v2_page.body["items"][0].get("request_version").is_some());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn leave_http_refuses_unlinked_reviewed_and_bootstrap_people(owner: PgPool) {
    let org = OrgId::new();
    let branch = BranchId::new();
    let maker = UserId::new();
    let checker = UserId::new();
    let employee = Uuid::new_v4();
    seed_subject(&owner, org, branch, maker, employee).await;
    seed_branch_admin(&owner, org, branch, checker).await;
    person_fixtures::bind_user_to_distinct_person(&owner, checker).await;
    let cases = person_fixtures::unverified_decision_parties(&owner, maker, checker).await;
    let definer = leave_definer_role_pool(&owner).await;
    sqlx::query("SELECT set_config('app.current_org',$1,false)")
        .bind(org.to_string())
        .execute(&definer)
        .await
        .unwrap();
    for (case, maker, checker) in cases {
        sqlx::query("INSERT INTO user_branches(org_id,user_id,branch_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING")
            .bind(org.as_uuid()).bind(checker.as_uuid()).bind(branch.as_uuid())
            .execute(&owner).await.unwrap();
        let id: Uuid = sqlx::query_scalar("INSERT INTO leave_requests(org_id,branch_id,requester_user_id,subject_employee_id,leave_type,days,start_date,end_date,status) VALUES($1,$2,$3,$4,'annual',1,'2026-10-01','2026-10-01','pending') RETURNING id")
            .bind(org.as_uuid()).bind(branch.as_uuid()).bind(maker.as_uuid()).bind(employee)
            .fetch_one(&definer).await.unwrap();
        let auth = test_auth_with_roles(&owner, checker, org, vec![branch], vec!["ADMIN"]).await;
        let rt = runtime_role_pool(&owner).await;
        let service = router(LeaveRestState::new(
            PgLeaveStore::new(rt.clone(), Arc::new(PgInboxStore::new(rt)))
                .with_leave_command_pool(leave_command_role_pool(&owner).await),
            Some(auth.verifier),
        ));
        for version in ["v1", "v2"] {
            let refused = request_json(service.clone(), "POST", &format!("/api/{version}/leave/requests/{id}/decide"),
                &auth.token, Some(if version == "v1" {json!({"decision":"time_change","comment":"시기 변경 협의"})} else {json!({"expected_version":1,"decision":"time_change","comment":"시기 변경 협의"})})).await;
            assert_eq!(
                refused.status,
                StatusCode::FORBIDDEN,
                "{case}: {}",
                refused.body
            );
            assert_eq!(
                refused.body["error"]["code"], "leave.refuse.identity_unbound",
                "{case}"
            );
        }
        let (status, decider): (String, Option<Uuid>) =
            sqlx::query_as("SELECT status,decided_by FROM leave_requests WHERE id=$1")
                .bind(id)
                .fetch_one(&owner)
                .await
                .unwrap();
        assert_eq!((status.as_str(), decider), ("pending", None));
    }
}
