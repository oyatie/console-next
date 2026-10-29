// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn employee_self_read_can_deny_a_different_employee(pool: PgPool) {
    use console_platform_authz::cedar_pbac::visible::load_facts;
    let org = OrgId::one();
    let employee = seed_employee(&pool, *org.as_uuid(), "Alice").await;
    let coworker = seed_employee(&pool, *org.as_uuid(), "Bob").await;
    let actor = UserId::new();
    seed_user_linked_to_employee(&pool, actor, *org.as_uuid(), employee).await;
    pay_view::grant_manage(&pool, org, actor, None).await;
    let rt = runtime_role_pool(&pool).await;
    let mut tx = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let facts = load_facts(&mut tx, org, *actor.as_uuid()).await.unwrap();
    assert!(facts.authorize_employee_self_read(employee).unwrap());
    assert!(!facts.authorize_employee_self_read(coworker).unwrap());
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn fact_loader_failure_is_internal_never_an_empty_page_or_denial(pool: PgPool) {
    let org = OrgId::one();
    let keys = keys();
    let actor = UserId::new();
    seed_user(&pool, actor, *org.as_uuid(), "MEMBER").await;
    pay_view::grant_view(&pool, org, actor, None).await;
    let token = bearer(&pool, &keys, actor, org, "MEMBER").await;
    let service = app(runtime_role_pool(&pool).await, &keys);
    // Break a table read used by the fact loader, after authentication succeeds.
    sqlx::query("REVOKE SELECT ON legal_entities FROM console_rt")
        .execute(&pool)
        .await
        .unwrap();
    for path in [PAYROLL_RUNS_PATH, PAYROLL_MY_PAYSLIPS_PATH] {
        let response = get(service.clone(), path, &token).await;
        assert_eq!(
            response.status,
            StatusCode::INTERNAL_SERVER_ERROR,
            "{}",
            response.json
        );
        assert_eq!(response.json["error"]["code"], "internal");
        assert!(response.json.get("items").is_none());
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn payslips_me_is_self_scoped_never_a_coworkers(pool: PgPool) {
    let keys = keys();
    let org = OrgId::one();

    let stager = UserId::new();
    seed_user(&pool, stager, *org.as_uuid(), "SUPER_ADMIN").await;
    let run = seed_run(&pool, *org.as_uuid(), stager).await;
    let alice_employee = seed_employee(&pool, *org.as_uuid(), "Alice").await;
    let bob_employee = seed_employee(&pool, *org.as_uuid(), "Bob").await;
    seed_line(&pool, *org.as_uuid(), run, alice_employee, "Alice").await;
    seed_line(&pool, *org.as_uuid(), run, bob_employee, "Bob").await;

    let alice_user = UserId::new();
    seed_user_linked_to_employee(&pool, alice_user, *org.as_uuid(), alice_employee).await;
    let bob_user = UserId::new();
    seed_user_linked_to_employee(&pool, bob_user, *org.as_uuid(), bob_employee).await;
    let admin_no_link = UserId::new();
    seed_user(&pool, admin_no_link, *org.as_uuid(), "ADMIN").await;

    let service = app(runtime_role_pool(&pool).await, &keys);
    let alice_token = bearer(&pool, &keys, alice_user, org, "MEMBER").await;
    let bob_token = bearer(&pool, &keys, bob_user, org, "MEMBER").await;

    let anon = get_unauthenticated(service.clone(), PAYROLL_MY_PAYSLIPS_PATH).await;
    assert_eq!(anon, StatusCode::UNAUTHORIZED);

    // Own readiness needs no tenant pay grant; run totals still do.
    let member_runs = get(service.clone(), PAYROLL_RUNS_PATH, &alice_token).await;
    assert_eq!(
        member_runs.status,
        StatusCode::FORBIDDEN,
        "MEMBER without PayrollRunRead must not list runs: {:?}",
        member_runs.json
    );
    assert_eq!(member_runs.json["error"]["code"], "forbidden");

    let alice_read = get(service.clone(), PAYROLL_MY_PAYSLIPS_PATH, &alice_token).await;
    assert_eq!(alice_read.status, StatusCode::OK, "{:?}", alice_read.json);
    assert_payslips_me_is_own_readiness(
        &alice_read.json,
        run,
        &[bob_employee, *bob_user.as_uuid()],
    );

    // A foreign employee_id query param is ignored, not an IDOR.
    let alice_idor = get(
        service.clone(),
        &format!("{PAYROLL_MY_PAYSLIPS_PATH}?employee_id={bob_employee}"),
        &alice_token,
    )
    .await;
    assert_eq!(alice_idor.status, StatusCode::OK, "{:?}", alice_idor.json);
    assert_payslips_me_is_own_readiness(
        &alice_idor.json,
        run,
        &[bob_employee, *bob_user.as_uuid()],
    );

    let bob_read = get(service.clone(), PAYROLL_MY_PAYSLIPS_PATH, &bob_token).await;
    assert_eq!(bob_read.status, StatusCode::OK, "{:?}", bob_read.json);
    assert_payslips_me_is_own_readiness(
        &bob_read.json,
        run,
        &[alice_employee, *alice_user.as_uuid()],
    );

    // An ADMIN with no employee link reads an empty page, not a 403, and
    // never leaks Alice's or Bob's rows.
    let admin_read = get(
        service,
        PAYROLL_MY_PAYSLIPS_PATH,
        &bearer(&pool, &keys, admin_no_link, org, "ADMIN").await,
    )
    .await;
    assert_eq!(
        admin_read.status,
        StatusCode::OK,
        "self-service read must not be forbidden: {:?}",
        admin_read.json
    );
    assert_eq!(admin_read.json["total"], 0);
    assert_eq!(
        admin_read.json["items"],
        json!([]),
        "unlinked account must not see anyone's draft lines: {:?}",
        admin_read.json
    );
    let mut admin_keys = BTreeSet::new();
    collect_keys(&admin_read.json, &mut admin_keys);
    for forbidden in VAULT_OR_ISSUED_PAYSLIP_KEYS {
        assert!(
            !admin_keys.contains(forbidden),
            "{forbidden} must not appear on the empty /payslips/me page: {:?}",
            admin_read.json
        );
    }
}
