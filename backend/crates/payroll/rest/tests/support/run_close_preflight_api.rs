use super::*;

// The full-database snapshot catches a verdict cached anywhere, including in an audit row.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn close_preflight_persists_no_verdict_only_its_read_audit(pool: PgPool) {
    let keys = Keys::generate();
    let rt = runtime_role_pool(&pool).await;
    let org = OrgId::one();
    seed_org(&pool, org).await;
    let executive = seed_user(&pool, org, "EXECUTIVE", None).await;
    let employee = seed_employee(&pool, org, "Alice").await;
    let run = seed_run(&pool, org, executive).await;
    let import_row = seed_verified_import_row(&pool, org).await;
    seed_calculable_line(&pool, org, run, employee, import_row).await;
    seed_period_lock(&pool, org).await;

    // Warm session activity before the all-table snapshot so it cannot mask a preflight write.
    let token = keys.token(&pool, executive, org, "EXECUTIVE").await;
    let (status, body) = send(
        &rt,
        &keys,
        "GET",
        &format!("/api/v1/payroll/runs/{run}"),
        &token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let before = snapshot_db(&pool).await;
    for table in [
        "public.payroll_draft_runs",
        "public.payroll_draft_lines",
        "public.audit_events",
        "public.workflow_outbox_events",
        "public.period_locks",
    ] {
        assert!(
            before.digests.contains_key(table),
            "{table} must be watched by the snapshot"
        );
    }
    for table in [
        "public.payroll_draft_runs",
        "public.payroll_draft_lines",
        "public.period_locks",
    ] {
        assert!(
            !before.digests[table].starts_with("0:"),
            "{table} must already hold rows for the digest to be able to change, got {:?}",
            before.digests[table]
        );
    }

    for pass in 1..=2 {
        let (status, preflight) = send(
            &rt,
            &keys,
            "GET",
            &format!("/api/v1/payroll/runs/{run}/close-preflight"),
            &token,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "pass {pass}: {preflight}");
        assert_eq!(
            preflight["can_close"], true,
            "pass {pass} must reach the can_close branch: {preflight}"
        );
    }
    let after = snapshot_db(&pool).await;
    assert_only_the_read_audit_changed(&before, &after, "can_close = true", 2);

    sqlx::query(
        "UPDATE period_locks SET unlocked_at = now(), unlock_reason = '동결창 해제' \
         WHERE domain = 'payroll'",
    )
    .execute(&pool)
    .await
    .unwrap();
    let before = snapshot_db(&pool).await;
    let (status, blocked) = send(
        &rt,
        &keys,
        "GET",
        &format!("/api/v1/payroll/runs/{run}/close-preflight"),
        &token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{blocked}");
    assert_eq!(
        blocked["can_close"], false,
        "must reach the blocked branch: {blocked}"
    );
    let after = snapshot_db(&pool).await;
    assert_only_the_read_audit_changed(&before, &after, "blocked", 1);

    let before = snapshot_db(&pool).await;
    let missing = Uuid::new_v4();
    let (status, body) = send(
        &rt,
        &keys,
        "GET",
        &format!("/api/v1/payroll/runs/{missing}/close-preflight"),
        &token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    let after = snapshot_db(&pool).await;
    let changed = changed_tables(&before.digests, &after.digests);
    assert!(
        changed.is_empty(),
        "a 404 preflight must persist nothing at all; changed: {changed:?}"
    );

    let reads: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events \
         WHERE action = 'payroll_run.preflight_read' AND target_id = $1",
    )
    .bind(run.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(reads, 3, "every preflight that read a run must be audited");
    let receipt: Option<serde_json::Value> =
        sqlx::query_scalar("SELECT close_receipt FROM payroll_draft_runs WHERE id = $1")
            .bind(run)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        receipt.is_none(),
        "preflight must not stash a verdict on the run: {receipt:?}"
    );
}
