// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
#[path = "../../../crates/payroll/rest/tests/fixtures/pay_view.rs"]
mod pay_view;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn action_inbox_payroll_source_enforces_sod_and_org_wide_manage(pool: PgPool) {
    let keys = keys();
    let branch = seed_branch(&pool, OrgId::one(), "급여 리전", "급여 지사").await;
    let submitter = UserId::new();
    seed_user(&pool, OrgId::one(), submitter, "EXECUTIVE", branch).await;
    let approver = UserId::new();
    seed_user(&pool, OrgId::one(), approver, "EXECUTIVE", branch).await;
    let admin = UserId::new();
    seed_user(&pool, OrgId::one(), admin, "ADMIN", branch).await;

    let submitted_at = OffsetDateTime::now_utc() - Duration::minutes(1);
    let run = seed_submitted_payroll_run(
        &pool,
        OrgId::one(),
        submitter,
        "inbox-sod-run",
        submitted_at,
    )
    .await;
    let _calculated = seed_payroll_run(
        &pool,
        OrgId::one(),
        "inbox-calc-run",
        "CALCULATED",
        None,
        None,
    )
    .await;

    let service =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());

    let legacy_only = get(
        service.clone(),
        PATH,
        &bearer(&pool, &keys, OrgId::one(), approver, "EXECUTIVE", branch).await,
    )
    .await;
    assert!(
        payroll_ids(&legacy_only.json).is_empty(),
        "legacy titles cannot grant payroll access: {:?}",
        legacy_only.json
    );
    let submitter_grant = pay_view::grant_manage(&pool, OrgId::one(), submitter, None).await;
    let grant = pay_view::grant_manage(&pool, OrgId::one(), approver, None).await;
    for (holder, grant_id) in [(submitter, submitter_grant), (approver, grant)] {
        let response = service
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/v1/access/grants/{grant_id}/notice"))
                    .header(
                        header::AUTHORIZATION,
                        format!(
                            "Bearer {}",
                            bearer(&pool, &keys, OrgId::one(), holder, "EXECUTIVE", branch).await
                        ),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    let submitter_resp = get(
        service.clone(),
        PATH,
        &bearer(&pool, &keys, OrgId::one(), submitter, "EXECUTIVE", branch).await,
    )
    .await;
    assert_eq!(
        submitter_resp.status,
        StatusCode::OK,
        "{:?}",
        submitter_resp.json
    );
    assert_eq!(
        payroll_ids(&submitter_resp.json),
        Vec::<String>::new(),
        "submitter must not see their own SUBMITTED run: {:?}",
        submitter_resp.json
    );
    assert_eq!(submitter_resp.json["total"], 0);

    // Workbench reuses PgActionInboxSources via list_complete_action_inbox.
    let submitter_workbench = get(
        service.clone(),
        "/api/v1/me/workbench",
        &bearer(&pool, &keys, OrgId::one(), submitter, "EXECUTIVE", branch).await,
    )
    .await;
    assert_eq!(
        submitter_workbench.status,
        StatusCode::OK,
        "{:?}",
        submitter_workbench.json
    );
    assert_eq!(
        submitter_workbench.json["action_inbox"]["status"], "ok",
        "{:?}",
        submitter_workbench.json
    );
    assert_eq!(
        payroll_ids(&submitter_workbench.json["action_inbox"]),
        Vec::<String>::new(),
        "submitter must not see their own SUBMITTED run through workbench list_source_page: {:?}",
        submitter_workbench.json
    );
    assert_eq!(submitter_workbench.json["action_inbox"]["total"], 0);

    let approver_resp = get(
        service.clone(),
        PATH,
        &bearer(&pool, &keys, OrgId::one(), approver, "EXECUTIVE", branch).await,
    )
    .await;
    assert_eq!(
        approver_resp.status,
        StatusCode::OK,
        "{:?}",
        approver_resp.json
    );
    assert_eq!(
        payroll_ids(&approver_resp.json),
        vec![format!("payroll:{run}")],
        "{:?}",
        approver_resp.json
    );
    assert_eq!(approver_resp.json["items"][0]["kind"], "payroll");
    assert_eq!(approver_resp.json["items"][0]["ref"], "inbox-sod-run");
    assert_eq!(approver_resp.json["total"], 1);

    let approver_workbench = get(
        service.clone(),
        "/api/v1/me/workbench",
        &bearer(&pool, &keys, OrgId::one(), approver, "EXECUTIVE", branch).await,
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
    assert_eq!(
        payroll_ids(&approver_workbench.json["action_inbox"]),
        vec![format!("payroll:{run}")],
        "{:?}",
        approver_workbench.json
    );
    assert_eq!(approver_workbench.json["action_inbox"]["total"], 1);

    let admin_resp = get(
        service.clone(),
        PATH,
        &bearer(&pool, &keys, OrgId::one(), admin, "ADMIN", branch).await,
    )
    .await;
    assert_eq!(admin_resp.status, StatusCode::OK, "{:?}", admin_resp.json);
    assert_eq!(
        payroll_ids(&admin_resp.json),
        Vec::<String>::new(),
        "branch-scoped ADMIN must see zero payroll inbox items: {:?}",
        admin_resp.json
    );
    assert_eq!(admin_resp.json["total"], 0);
    let token = bearer(&pool, &keys, OrgId::one(), approver, "EXECUTIVE", branch).await;
    for enabled in [false, true] {
        // rls-arming: ok fixture toggles the tenant module after the same inbox session has read it.
        let effective: OffsetDateTime = sqlx::query_scalar("INSERT INTO tenant_setting_overrides(org_id,key,value,effective_from,set_by,reason_code) VALUES ($1,'module.payroll.enabled',$2,clock_timestamp(),$3,'POLICY_REVIEW') RETURNING effective_from")
            .bind(OrgId::one().as_uuid()).bind(json!(enabled)).bind(approver.as_uuid()).fetch_one(&pool).await.unwrap();
        if let Ok(wait) = (effective - OffsetDateTime::now_utc()).try_into() {
            tokio::time::sleep(wait).await;
        }
        let response = get(service.clone(), PATH, &token).await;
        assert_eq!(response.status, StatusCode::OK, "{:?}", response.json);
        assert_eq!(
            payroll_ids(&response.json),
            if enabled {
                vec![format!("payroll:{run}")]
            } else {
                vec![]
            }
        );
        assert_eq!(response.json["total"], if enabled { 1 } else { 0 });
    }
    // rls-arming: ok revocation must not fall back to the caller's legacy title.
    sqlx::query(
        "UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=$2 WHERE id=$1",
    )
    .bind(grant)
    .bind(approver.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    let revoked = get(service, PATH, &token).await;
    assert_eq!(revoked.status, StatusCode::OK, "{:?}", revoked.json);
    assert!(payroll_ids(&revoked.json).is_empty());
    assert_eq!(revoked.json["total"], 0);
}
