// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

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

    // No pay grant means neither tenant runs nor own readiness can be read.
    let member_runs = get(service.clone(), PAYROLL_RUNS_PATH, &alice_token).await;
    assert_eq!(
        member_runs.status,
        StatusCode::FORBIDDEN,
        "MEMBER without PayrollRunRead must not list runs: {:?}",
        member_runs.json
    );
    assert_eq!(member_runs.json["error"]["code"], "forbidden");

    let denied_self = get(service.clone(), PAYROLL_MY_PAYSLIPS_PATH, &alice_token).await;
    assert_eq!(denied_self.status, StatusCode::FORBIDDEN);
    for user in [alice_user, bob_user, admin_no_link] {
        pay_view::grant_view(&pool, org, user, None).await;
    }
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
