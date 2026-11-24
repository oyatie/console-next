use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn readiness_counts_only_inspectable_active_payroll_close_statuses(pool: PgPool) {
    let keys = keys();
    let org = OrgId::one();
    let user = UserId::new();
    seed_user(&pool, org, user).await;

    for (source_label, status, calculation_enabled) in [
        ("terminal-issued", "ISSUED", true),
        ("terminal-void", "VOID", false),
    ] {
        sqlx::query(
            "INSERT INTO payroll_draft_runs \
             (id, org_id, period_start, period_end, source_label, status, calculation_enabled, created_by) \
             VALUES ($1, $2, '2026-07-01', '2026-07-31', $3, $4, $5, $6)",
        )
        .bind(Uuid::new_v4())
        .bind(*org.as_uuid())
        .bind(source_label)
        .bind(status)
        .bind(calculation_enabled)
        .bind(*user.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    }

    let service = build_router(
        app_state(
            runtime_role_pool(&pool).await,
            leave_command_role_pool(&pool).await,
            &keys,
        )
        .unwrap(),
    );
    let token = bearer(&pool, &keys, org, user, &["SUPER_ADMIN"]).await;

    let terminal_only = get(service.clone(), HR_READINESS_SUMMARY_PATH, &token).await;
    assert_eq!(
        terminal_only.status,
        StatusCode::OK,
        "{:?}",
        terminal_only.json
    );
    assert_eq!(terminal_only.json["payroll"]["draft_runs"], 2);
    assert_eq!(terminal_only.json["payroll"]["active_close_runs"], 0);

    for (source_label, status, calculation_enabled) in [
        ("active-staged", "STAGED", false),
        ("active-blocked", "BLOCKED_LEGAL_GATE", false),
        ("active-ready", "READY_FOR_REVIEW", true),
        ("active-approved", "APPROVED", true),
    ] {
        sqlx::query(
            "INSERT INTO payroll_draft_runs \
             (id, org_id, period_start, period_end, source_label, status, calculation_enabled, created_by) \
             VALUES ($1, $2, '2026-08-01', '2026-08-31', $3, $4, $5, $6)",
        )
        .bind(Uuid::new_v4())
        .bind(*org.as_uuid())
        .bind(source_label)
        .bind(status)
        .bind(calculation_enabled)
        .bind(*user.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    }

    let active = get(service, HR_READINESS_SUMMARY_PATH, &token).await;
    assert_eq!(active.status, StatusCode::OK, "{:?}", active.json);
    assert_eq!(active.json["payroll"]["active_close_runs"], 4);
}

/// The summary is read with directory access alone, so it describes only runs
/// staged from imports: a pay group's run, its roster and its existence are for
/// those its pay-group access admits.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn readiness_leaves_out_the_runs_and_lines_of_pay_groups(pool: PgPool) {
    let keys = keys();
    let org = OrgId::one();
    let user = UserId::new();
    seed_user(&pool, org, user).await;
    sqlx::query(
        "WITH run AS (INSERT INTO payroll_draft_runs \
           (org_id, period_start, period_end, source_label, updated_at) \
           VALUES ($1, '2026-05-01', '2026-05-31', 'import-run', now() - interval '1 day') \
           RETURNING id) \
         INSERT INTO payroll_draft_lines \
           (org_id, run_id, employee_source_key, employee_display_name, employee_company) \
         SELECT $1, id, 'imported', 'Imported', 'SAE' FROM run",
    )
    .bind(*org.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    let service = build_router(
        app_state(
            runtime_role_pool(&pool).await,
            leave_command_role_pool(&pool).await,
            &keys,
        )
        .unwrap(),
    );
    let token = bearer(&pool, &keys, org, user, &["SUPER_ADMIN"]).await;
    let before = get(service.clone(), HR_READINESS_SUMMARY_PATH, &token).await;
    // A sensitive group's run, created as run creation stores it (its own id as
    // the label), with one roster line, and the most recently updated run.
    sqlx::query(
        "WITH entity AS (INSERT INTO legal_entities (org_id, id, needs_confirmation, created_change_mode) \
           VALUES ($1, gen_random_uuid(), true, 'MIGRATION') RETURNING id), \
         grp AS (INSERT INTO pay_groups (org_id, id, legal_entity_id, name, pay_date_rule, base_period, \
           variable_period, proration, channel, sensitive, pay_basis_allowed) \
           SELECT $1, gen_random_uuid(), id, 'Executive pay', \
             '{\"day\":\"LAST_DAY\",\"month_offset\":0,\"non_business_day\":\"PREVIOUS\"}', \
             '{\"start_day\":\"FIRST\",\"month_offset\":0}', '{\"start_day\":16,\"month_offset\":-1}', \
             'CALENDAR_DAYS', 'ATTESTATION_ONLY', true, ARRAY['MONTHLY'] FROM entity RETURNING id), \
         run AS (INSERT INTO payroll_draft_runs (org_id, id, pay_group_id, kind, attribution_month, \
           pay_date, period_start, period_end, variable_period_start, variable_period_end, source_label) \
           SELECT $1, $2, id, 'REGULAR', DATE '2026-06-01', DATE '2026-06-30', DATE '2026-06-01', \
             DATE '2026-06-30', DATE '2026-05-16', DATE '2026-06-15', $2::text FROM grp RETURNING id) \
         INSERT INTO payroll_draft_lines \
           (org_id, run_id, employee_source_key, employee_display_name, employee_company) \
         SELECT $1, id, 'executive', 'Executive', 'SAE' FROM run",
    )
    .bind(*org.as_uuid())
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .unwrap();
    let after = get(service, HR_READINESS_SUMMARY_PATH, &token).await;
    assert_eq!(
        (
            after.status,
            &before.json["payroll"]["draft_runs"],
            &before.json["payroll"]["draft_lines"],
            &after.json["payroll"]
        ),
        (
            StatusCode::OK,
            &json!(1),
            &json!(1),
            &before.json["payroll"]
        )
    );
}
