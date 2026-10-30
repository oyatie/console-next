#[path = "../fixtures/pay_view.rs"]
mod pay_view;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn executive_drives_full_lifecycle_with_audit_readback(pool: PgPool) {
    let keys = Keys::generate();
    let rt = runtime_role_pool(&pool).await;
    let org = OrgId::one();
    seed_org(&pool, org).await;

    let submitter = seed_user(&pool, org, "EXECUTIVE", None).await;
    let decider = seed_user(&pool, org, "EXECUTIVE", None).await;
    pay_view::grant_manage(&pool, org, submitter, None).await;
    pay_view::grant_manage(&pool, org, decider, None).await;
    let submitter_token = keys.token(&pool, submitter, org, "EXECUTIVE").await;
    let decider_token = keys.token(&pool, decider, org, "EXECUTIVE").await;

    let employee = seed_employee(&pool, org, "Alice").await;
    let recipient = seed_user(&pool, org, "MEMBER", Some(employee)).await;
    let run = seed_run(&pool, org, submitter).await;
    let import_row = seed_verified_import_row(&pool, org).await;
    seed_calculable_line(&pool, org, run, employee, import_row).await;

    // ---- Close preflight: fail-closed while the payroll period lock is
    // missing; the check names itself and close 409s with the receipt.
    let (status, preflight) = send(
        &rt,
        &keys,
        "GET",
        &format!("/api/v1/payroll/runs/{run}/close-preflight"),
        &submitter_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preflight}");
    assert_eq!(preflight["can_close"], false);
    let lock_check = preflight["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|check| check["key"] == "period_lock")
        .expect("period_lock check present");
    assert_eq!(lock_check["ok"], false);

    let (status, blocked) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/close-attendance"),
        &submitter_token,
        Some(json!({"attest": true})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{blocked}");
    assert_eq!(blocked["error"]["code"], "preflight_blocked");
    assert_eq!(blocked["error"]["details"]["can_close"], false);

    seed_period_lock(&pool, org).await;

    // Attestation is mandatory.
    let (status, unattested) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/close-attendance"),
        &submitter_token,
        Some(json!({"attest": false})),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{unattested}");

    let (status, closed) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/close-attendance"),
        &submitter_token,
        Some(json!({"attest": true})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{closed}");
    assert_eq!(closed["run"]["status"], "ATTENDANCE_CLOSED");
    assert_eq!(
        closed["run"]["close_receipt"]["attested_by"],
        json!(submitter.as_uuid()),
        "close receipt records the attestor"
    );

    // ---- Calculate: real kernel math from the verified source ledger row.
    let (status, calculated) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/calculate"),
        &submitter_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{calculated}");
    assert_eq!(calculated["run"]["status"], "CALCULATED");
    let calc = &calculated["calculation"];
    assert_eq!(calc["calculated_lines"], 1);
    assert_eq!(calc["blocked_lines"], 0);
    assert_eq!(
        calc["total_net_won"], 2_626_700,
        "3,000,000 gross with the June 2026 statutory tables + verified NTS row"
    );
    assert_eq!(calc["payable"], false, "draft until the release gate flips");
    assert_eq!(
        calculated["exceptions_open"], 1,
        "overtime hours raise 예외"
    );

    // ---- Submit is fail-closed while exceptions are open.
    let (status, refused) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/submit"),
        &submitter_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "exceptions_open");

    let (status, exceptions) = send(
        &rt,
        &keys,
        "GET",
        &format!("/api/v1/payroll/runs/{run}/exceptions"),
        &submitter_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{exceptions}");
    assert_eq!(exceptions["open"], 1);
    let exception = &exceptions["items"][0];
    assert_eq!(exception["kind"], "OVERTIME_ALLOWANCE");
    assert_eq!(exception["status"], "OPEN");
    assert!(
        exception["amount_delta_won"].is_null(),
        "no verified source for the delta — must be null, never an estimate"
    );
    let exception_id = exception["id"].as_str().unwrap().to_owned();

    // HOLD requires a reason; CONFIRM resolves; a second resolve conflicts.
    let (status, no_reason) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/exceptions/{exception_id}/resolve"),
        &submitter_token,
        Some(json!({"action": "HOLD"})),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{no_reason}");
    let (status, confirmed) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/exceptions/{exception_id}/resolve"),
        &submitter_token,
        Some(json!({"action": "CONFIRM"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{confirmed}");
    assert_eq!(confirmed["status"], "CONFIRMED");
    let (status, replay) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/exceptions/{exception_id}/resolve"),
        &submitter_token,
        Some(json!({"action": "CONFIRM"})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{replay}");
    assert_eq!(replay["error"]["code"], "already_resolved");

    // ---- Submit, then SoD: the submitter may not decide.
    let (status, submitted) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/submit"),
        &submitter_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{submitted}");
    assert_eq!(submitted["run"]["status"], "SUBMITTED");

    let (status, sod) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/decision"),
        &submitter_token,
        Some(json!({"decision": "APPROVE"})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{sod}");
    assert_eq!(sod["error"]["code"], "sod_violation");

    // ---- Reject (reason required) → withdraw → resubmit → approve.
    let (status, no_reason) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/decision"),
        &decider_token,
        Some(json!({"decision": "REJECT"})),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{no_reason}");
    let (status, rejected) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/decision"),
        &decider_token,
        Some(json!({"decision": "REJECT", "reason": "지급 계좌 재확인"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{rejected}");
    assert_eq!(rejected["run"]["status"], "REJECTED");

    let (status, withdrawn) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/withdraw"),
        &submitter_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{withdrawn}");
    assert_eq!(withdrawn["run"]["status"], "CALCULATED");

    let (status, _) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/submit"),
        &submitter_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, approved) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/decision"),
        &decider_token,
        Some(json!({"decision": "APPROVE"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{approved}");
    assert_eq!(approved["run"]["status"], "APPROVED");

    // ---- Issuing BEFORE the run is PAID must refuse, and must leak no payslip.
    //
    // THIS BLOCK MUST STAY ABOVE THE LEGITIMATE ISSUANCE BELOW. `emit_inbox_doc`
    // dedups on `payroll-run:{run}:line:{line}`, so a leaked document created
    // after the real one collapses into it and the `leaked == 0` assertion below
    // becomes vacuously true. Order is load-bearing here, not stylistic.
    //
    // The release gate is registered FIRST so that the PAID check is the guard
    // actually under test: without it the request is refused by the legal gate
    // and this proves nothing about status. The gate is removed again
    // afterwards, so the legal-gate refusal below still exercises its own path.
    //
    // The status assertion alone would NOT catch a missing PAID check.
    // `record_payslip_deliveries_in_tx` raises the identical `invalid_state`
    // error, so the 409 survives even with the guard deleted. What does not
    // survive is the vault: `issue_payslips` emits documents OUTSIDE the
    // refusing transaction, so a payslip for an unpaid run reaches the
    // employee's inbox while the caller sees a clean refusal. That is what the
    // count asserts.
    register_release_gate(&pool, run).await;
    let (status, premature) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/issue-payslips"),
        &submitter_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{premature}");
    let leaked: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM inbox_docs WHERE kind = 'payslip' AND source_id = $1",
    )
    .bind(run.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        leaked, 0,
        "a run at APPROVED must issue no payslip; the caller's 409 does not undo a document \
         already emitted outside the refusing transaction"
    );
    let recipient_inbox: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM inbox_docs WHERE kind = 'payslip' AND recipient_user_id = $1",
    )
    .bind(*recipient.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        recipient_inbox, 0,
        "the employee recipient's inbox must stay empty after a refused issuance"
    );

    // An org-B EXECUTIVE: this run is indistinguishable from a missing one
    // on the issue-payslips write path (RLS deny-by-omission). 404 omit, not 403.
    let org_b = OrgId::from_uuid(Uuid::new_v4());
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, 'org-b', 'Org B')")
        .bind(*org_b.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let outsider = seed_user(&pool, org_b, "EXECUTIVE", None).await;
    pay_view::grant_manage(&pool, org_b, outsider, None).await;
    let outsider_token = keys.token(&pool, outsider, org_b, "EXECUTIVE").await;
    let (status, omitted) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/issue-payslips"),
        &outsider_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{omitted}");
    assert_eq!(omitted["error"]["code"], "not_found");

    sqlx::query(
        "UPDATE payroll_draft_runs SET legal_basis = legal_basis - 'release_gate' WHERE id = $1",
    )
    .bind(run)
    .execute(&pool)
    .await
    .unwrap();

    // ---- Disbursement: past date 422; then the operator-attested FSM.
    let past = (OffsetDateTime::now_utc() - Duration::hours(1))
        .format(&Rfc3339)
        .unwrap();
    let (status, _) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/schedule-disbursement"),
        &submitter_token,
        Some(json!({"scheduled_at": past})),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let future = (OffsetDateTime::now_utc() + Duration::days(1))
        .format(&Rfc3339)
        .unwrap();
    let (status, scheduled) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/schedule-disbursement"),
        &submitter_token,
        Some(json!({"scheduled_at": future})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{scheduled}");
    assert_eq!(scheduled["status"], "SCHEDULED");

    // PAID straight from SCHEDULED is an invalid operator attestation.
    let (status, skipped) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/disbursement/attest"),
        &submitter_token,
        Some(json!({"status": "PAID"})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{skipped}");
    assert_eq!(skipped["error"]["code"], "invalid_transition");
    let (status, _) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/disbursement/attest"),
        &submitter_token,
        Some(json!({"status": "SUBMITTED_TO_BANK"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, paid) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/disbursement/attest"),
        &submitter_token,
        Some(json!({"status": "PAID"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{paid}");
    assert_eq!(paid["status"], "PAID");

    // ---- Payslip issuance is hard-gated by the registered release gate.
    let (status, gate) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/issue-payslips"),
        &submitter_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{gate}");
    assert_eq!(gate["error"]["code"], "legal_gate");

    register_release_gate(&pool, run).await;

    issue_revocation::assert_second_gate(&pool, &rt, &keys, org, submitter, run, &submitter_token)
        .await;
    let (status, issued) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/issue-payslips"),
        &submitter_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{issued}");
    assert_eq!(issued["issued"], 1);
    assert_eq!(issued["acknowledged"], 0);

    // Replay after ISSUED is a typed conflict, and the vault holds exactly
    // one deduped payslip document sourced from this run.
    let (status, replay) = send(
        &rt,
        &keys,
        "POST",
        &format!("/api/v1/payroll/runs/{run}/issue-payslips"),
        &submitter_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{replay}");
    let docs: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM inbox_docs WHERE kind = 'payslip' AND source_id = $1",
    )
    .bind(run.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(docs, 1);
    let emits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events a JOIN inbox_docs d ON a.target_id=d.id::text
         WHERE a.action='inbox_doc.emit' AND d.kind='payslip' AND d.source_id=$1",
    )
    .bind(run.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        emits, 1,
        "successful issuance emits exactly one document audit; refusal and replay emit none"
    );

    let (status, delivery) = send(
        &rt,
        &keys,
        "GET",
        &format!("/api/v1/payroll/runs/{run}/payslip-delivery"),
        &decider_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{delivery}");
    assert_eq!(delivery["issued"], 1);
    assert_eq!(delivery["items"][0]["acknowledged_at"], Value::Null);

    let (status, final_detail) = send(
        &rt,
        &keys,
        "GET",
        &format!("/api/v1/payroll/runs/{run}"),
        &decider_token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(final_detail["run"]["status"], "ISSUED");

    // ---- Audit readback: every lifecycle mutation left its event.
    for action in [
        "payroll_run.close",
        "payroll_run.calculate",
        "payroll_run.submit",
        "payroll_run.decide",
        "payroll_run.withdraw",
        "payroll_run.disburse_schedule",
        "payroll_run.disburse_attest",
        "payroll_run.payslip_issue",
    ] {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_events WHERE action = $1 AND (target_id = $2 OR \
             target_type = 'payroll_disbursement')",
        )
        .bind(action)
        .bind(run.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(count >= 1, "audit action {action} must be recorded");
    }
    let resolve_audits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE action = 'payroll_run.exception_resolve'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        resolve_audits, 1,
        "exactly the one successful resolve audits"
    );
}
