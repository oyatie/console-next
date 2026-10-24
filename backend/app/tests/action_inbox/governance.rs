use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn action_inbox_governance_source_enforces_requester_sod(pool: PgPool) {
    let keys = keys();
    let branch = seed_branch(&pool, OrgId::one(), "결재 리전", "결재 지사").await;
    let requester = UserId::new();
    seed_user(&pool, OrgId::one(), requester, "SUPER_ADMIN", branch).await;
    let approver = UserId::new();
    seed_user(&pool, OrgId::one(), approver, "SUPER_ADMIN", branch).await;
    let member = UserId::new();
    seed_user(&pool, OrgId::one(), member, "MEMBER", branch).await;
    // company.*/hr.*/payroll.* four-eyes is a distinct-natural-person bar.
    let requester_employee =
        bind_user_to_new_person(&pool, OrgId::one(), requester, "gov-inbox-req").await;
    let approver_employee =
        bind_user_to_new_person(&pool, OrgId::one(), approver, "gov-inbox-app").await;
    let expected_register: BTreeSet<String> = [requester_employee, approver_employee]
        .into_iter()
        .map(|id| format!("hr_register:{id}"))
        .collect();
    let expected_branch: BTreeSet<String> = [requester_employee, approver_employee]
        .into_iter()
        .map(|id| format!("hr_branch:{id}"))
        .collect();
    let expected_identity: BTreeSet<String> = [requester_employee, approver_employee]
        .into_iter()
        .map(|id| format!("hr_identity:{id}"))
        .collect();
    let followups = expected_register.len() + expected_branch.len() + expected_identity.len();

    let created_at = OffsetDateTime::now_utc() - Duration::minutes(1);
    let company =
        seed_pending_approval(&pool, OrgId::one(), requester, "company.revise", created_at).await;
    let hr = seed_pending_approval(
        &pool,
        OrgId::one(),
        requester,
        "hr.appoint",
        created_at + Duration::seconds(1),
    )
    .await;
    let payroll = seed_pending_approval(
        &pool,
        OrgId::one(),
        requester,
        "payroll.create_run",
        created_at + Duration::seconds(2),
    )
    .await;
    let decided = seed_pending_approval(
        &pool,
        OrgId::one(),
        requester,
        "override",
        created_at - Duration::seconds(1),
    )
    .await;
    seed_approval_decision(
        &pool,
        OrgId::one(),
        decided.request_ref,
        requester,
        approver,
    )
    .await;
    let expected_governance = vec![
        format!("governance:{}", company.id),
        format!("governance:{}", hr.id),
        format!("governance:{}", payroll.id),
    ];

    let service =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());

    let requester_resp = get(
        service.clone(),
        PATH,
        &bearer(&pool, &keys, OrgId::one(), requester, "SUPER_ADMIN", branch).await,
    )
    .await;
    assert_eq!(
        requester_resp.status,
        StatusCode::OK,
        "{:?}",
        requester_resp.json
    );
    assert_eq!(
        source_ids(&requester_resp.json, "governance:"),
        Vec::<String>::new(),
        "requester must not see their own pending company.*/hr.*/payroll.* items: {:?}",
        requester_resp.json
    );
    assert_eq!(
        source_ids(&requester_resp.json, "hr_register:")
            .into_iter()
            .collect::<BTreeSet<_>>(),
        expected_register
    );
    assert_eq!(
        source_ids(&requester_resp.json, "hr_branch:")
            .into_iter()
            .collect::<BTreeSet<_>>(),
        expected_branch
    );
    assert_eq!(
        source_ids(&requester_resp.json, "hr_identity:")
            .into_iter()
            .collect::<BTreeSet<_>>(),
        expected_identity
    );
    assert_eq!(requester_resp.json["total"], followups);

    // Workbench reuses PgActionInboxSources via list_complete_action_inbox.
    let requester_workbench = get(
        service.clone(),
        "/api/v1/me/workbench",
        &bearer(&pool, &keys, OrgId::one(), requester, "SUPER_ADMIN", branch).await,
    )
    .await;
    assert_eq!(
        requester_workbench.status,
        StatusCode::OK,
        "{:?}",
        requester_workbench.json
    );
    assert_eq!(
        requester_workbench.json["action_inbox"]["status"], "ok",
        "{:?}",
        requester_workbench.json
    );
    assert_eq!(
        source_ids(&requester_workbench.json["action_inbox"], "governance:"),
        Vec::<String>::new(),
        "requester must not see their own pending four-eyes item through workbench list_source_page: {:?}",
        requester_workbench.json
    );
    assert_eq!(
        source_ids(&requester_workbench.json["action_inbox"], "hr_register:")
            .into_iter()
            .collect::<BTreeSet<_>>(),
        expected_register
    );
    assert_eq!(requester_workbench.json["action_inbox"]["total"], followups);

    let approver_resp = get(
        service.clone(),
        PATH,
        &bearer(&pool, &keys, OrgId::one(), approver, "SUPER_ADMIN", branch).await,
    )
    .await;
    assert_eq!(
        approver_resp.status,
        StatusCode::OK,
        "{:?}",
        approver_resp.json
    );
    assert_eq!(
        source_ids(&approver_resp.json, "governance:"),
        expected_governance,
        "{:?}",
        approver_resp.json
    );
    assert_eq!(approver_resp.json["items"][0]["kind"], "governance");
    assert_eq!(approver_resp.json["items"][0]["title"], "company.revise");
    assert_eq!(approver_resp.json["items"][1]["title"], "hr.appoint");
    assert_eq!(
        approver_resp.json["items"][2]["title"],
        "payroll.create_run"
    );
    assert_eq!(
        approver_resp.json["items"][0]["ref"],
        company.request_ref.to_string()
    );
    assert_eq!(
        source_ids(&approver_resp.json, "hr_register:")
            .into_iter()
            .collect::<BTreeSet<_>>(),
        expected_register
    );
    assert_eq!(
        approver_resp.json["total"],
        followups + expected_governance.len()
    );

    let approver_workbench = get(
        service.clone(),
        "/api/v1/me/workbench",
        &bearer(&pool, &keys, OrgId::one(), approver, "SUPER_ADMIN", branch).await,
    )
    .await;
    assert_eq!(
        approver_workbench.status,
        StatusCode::OK,
        "{:?}",
        approver_workbench.json
    );
    assert_eq!(
        approver_workbench.json["action_inbox"]["status"], "ok",
        "{:?}",
        approver_workbench.json
    );
    // Workbench merges sources; membership is the SoD lock, not inter-source
    // sort order. `/action-inbox` above already pins created_at order.
    let workbench_ids: BTreeSet<String> =
        source_ids(&approver_workbench.json["action_inbox"], "governance:")
            .into_iter()
            .collect();
    let expected_ids: BTreeSet<String> = expected_governance.iter().cloned().collect();
    assert_eq!(workbench_ids, expected_ids, "{:?}", approver_workbench.json);
    assert_eq!(
        source_ids(&approver_workbench.json["action_inbox"], "hr_register:")
            .into_iter()
            .collect::<BTreeSet<_>>(),
        expected_register
    );
    assert_eq!(
        approver_workbench.json["action_inbox"]["total"],
        followups + expected_governance.len()
    );

    let member_resp = get(
        service,
        PATH,
        &bearer(&pool, &keys, OrgId::one(), member, "MEMBER", branch).await,
    )
    .await;
    assert_eq!(member_resp.status, StatusCode::OK, "{:?}", member_resp.json);
    assert_eq!(
        source_ids(&member_resp.json, "governance:"),
        Vec::<String>::new(),
        "a caller who cannot decide must not see pending four-eyes: {:?}",
        member_resp.json
    );
    assert_eq!(member_resp.json["total"], 0);
}
