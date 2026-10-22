// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn exit_case_state_machine_enforces_transitions_and_reverses_exits(pool: PgPool) {
    let (ctx, org, admin) = setup(&pool).await;
    let hq = seed_user(&pool, org, "SUPER_ADMIN").await;
    let hq_token = token(&pool, &ctx.keys, org, hq, "SUPER_ADMIN").await;
    let head = |id: Uuid| {
        let pool = pool.clone();
        async move {
            sqlx::query_as::<_, (String, Option<String>)>(
                "SELECT employment_status, exit_date::TEXT FROM employees WHERE id = $1",
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    let conflict = |(status, body): (StatusCode, Value)| {
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["error"]["code"], "invalid_transition", "{body}");
    };
    let cancel_conflict = |(status, body): (StatusCode, Value)| {
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(
            body["error"]["code"], "exit_cancel_after_hr_confirmation",
            "{body}"
        );
    };
    let reason = json!({"reason": "현장 확인 결과 출근 중"});
    let settlement = json!({
        "average_wage_period_start": "2026-04-01",
        "average_wage_period_end": "2026-06-29",
        "average_wage_calendar_days": 90,
        "average_wage_total_won": 9_000_000,
        "monthly_ordinary_wage_won": 3_000_000,
    });

    // --- HR confirmation carries the four TERMINATE acknowledgements. ---
    let early = seed_employee(&pool, org, "예정 퇴사").await;
    let case = ctx.report_exit_on(early, "2099-06-30").await;
    let (status, body) = ctx
        .exit_action(&case, "confirm", &ctx.token, json!({}))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "lifecycle_signoff_required");
    assert_eq!(
        body["error"]["message"],
        "privacy_notice_ack is required for TERMINATE"
    );
    let (status, body) = ctx
        .exit_action(&case, "confirm", &ctx.token, json!({"signoffs": base()}))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(
        body["error"]["message"],
        "payroll_cutoff_ack is required for TERMINATE"
    );

    // --- Reported and confirmed ahead of the exit date: the exit is scheduled. ---
    let (status, body) = ctx
        .exit_action(&case, "confirm", &ctx.token, hr_confirm())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "HR_CONFIRMED");
    assert_eq!(body["exit_event_state"], "SCHEDULED");
    let exit_event = body["exit_lifecycle_event_id"].as_str().unwrap().to_owned();
    assert_eq!(head(early).await, ("ACTIVE".to_owned(), None));
    let (status, detail) = ctx
        .send(
            "GET",
            &format!("/api/v1/employees/{early}"),
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["employee"]["next_event"]["id"], exit_event.as_str());
    assert_eq!(detail["employee"]["next_event"]["event_type"], "TERMINATE");
    // A scheduled exit belongs to its case: the lifecycle cancel refuses it.
    let (status, body) = ctx
        .send(
            "POST",
            &format!("/api/v1/employees/{early}/lifecycle-events/{exit_event}/cancel"),
            &ctx.token,
            None,
            None,
            Some(json!({"reason": "철회"})),
        )
        .await;
    conflict((status, body));
    // Rejecting the case withdraws the scheduled exit; nothing to reverse.
    let (status, body) = ctx
        .exit_action(&case, "reject", &ctx.token, reason.clone())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["exit_event_state"], "CANCELLED");
    assert_eq!(head(early).await, ("ACTIVE".to_owned(), None));
    let (status, page) = ctx
        .send(
            "GET",
            &format!("/api/v1/employees/{early}/lifecycle-events"),
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(
        page["items"].as_array().unwrap().len(),
        1,
        "no EXIT_REVERSAL: {page}"
    );
    assert_eq!(page["items"][0]["state"], "CANCELLED");

    // --- ACTIVE employee: HR confirm exits, rejection compensates. ---
    let emp = seed_employee(&pool, org, "취소 대상").await;
    let case = ctx.report_exit(emp).await;
    conflict(
        ctx.exit_action(
            &case,
            "confirm",
            &hq_token,
            json!({"hq_confirmation": true}),
        )
        .await,
    );
    conflict(
        ctx.exit_action(&case, "approval-draft", &ctx.token, json!({}))
            .await,
    );
    // The retired `decision` field is refused, never read as a confirmation.
    let (status, body) = ctx
        .exit_action(&case, "confirm", &ctx.token, json!({"decision": "REJECT"}))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(head(emp).await, ("ACTIVE".to_owned(), None));
    let (status, body) = ctx
        .exit_action(&case, "confirm", &ctx.token, hr_confirm())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "HR_CONFIRMED");
    assert_eq!(body["next_actions"][0]["key"], "confirm_exit_hq");
    assert_eq!(
        head(emp).await,
        ("EXITED".to_owned(), Some("2026-06-30".to_owned()))
    );
    conflict(
        ctx.exit_action(&case, "confirm", &hq_token, json!({}))
            .await,
    );
    let (status, body) = ctx
        .exit_action(
            &case,
            "confirm",
            &ctx.token,
            json!({"hq_confirmation": true}),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "HQ must be a different person: {body}"
    );
    conflict(
        ctx.exit_action(&case, "approval-draft", &ctx.token, json!({}))
            .await,
    );
    for missing in [json!({"reason": "   "}), json!({})] {
        let (status, body) = ctx.exit_action(&case, "cancel", &ctx.token, missing).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    }
    let (status, body) = ctx
        .exit_action(&case, "reject", &ctx.token, reason.clone())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "REJECTED");
    assert_eq!(body["closed_reason"], "현장 확인 결과 출근 중");
    assert_eq!(body["closed_by"], admin.as_uuid().to_string());
    assert_eq!(body["next_actions"], json!([]));
    assert_eq!(head(emp).await, ("ACTIVE".to_owned(), None));
    let (status, page) = ctx
        .send(
            "GET",
            &format!("/api/v1/employees/{emp}/lifecycle-events"),
            &ctx.token,
            None,
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["items"][0]["event_type"], "EXIT_REVERSAL");
    assert_eq!(page["items"][0]["from_status"], "EXITED");
    assert_eq!(page["items"][0]["to_status"], "ACTIVE");
    let today_kst = (OffsetDateTime::now_utc() + Duration::hours(9))
        .date()
        .to_string();
    assert_eq!(
        page["items"][0]["effective_date"], today_kst,
        "reversal is dated in KST"
    );
    assert_eq!(page["items"][1]["event_type"], "TERMINATE");
    assert_eq!(
        page["items"][1]["comment"], "무단결근 보고",
        "the history shows the reported reason"
    );
    let reversal: Value = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE action = 'employee.exit.reject' AND target_id = $1",
    )
    .bind(&case)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(reversal["from_status"], "HR_CONFIRMED");
    assert_eq!(reversal["restored_employment_status"], "ACTIVE");
    assert_eq!(
        reversal["reversal_lifecycle_event_id"],
        page["items"][0]["id"]
    );
    // REJECTED is terminal.
    for (action, body) in [
        ("confirm", json!({})),
        ("approval-draft", json!({})),
        ("reject", reason.clone()),
        ("cancel", reason.clone()),
    ] {
        conflict(ctx.exit_action(&case, action, &ctx.token, body).await);
    }

    // --- Cancel before HR confirmation: nothing to reverse. ---
    let untouched = seed_employee(&pool, org, "보고만 취소").await;
    let case = ctx.report_exit(untouched).await;
    let (status, body) = ctx
        .exit_action(&case, "cancel", &ctx.token, reason.clone())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(head(untouched).await, ("ACTIVE".to_owned(), None));
    let events: i64 =
        sqlx::query_scalar("SELECT count(*) FROM employee_lifecycle_events WHERE employee_id = $1")
            .bind(untouched)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(events, 0);

    // --- ON_LEAVE employee: two-tier confirm, then reject restores ON_LEAVE. ---
    let on_leave = seed_employee(&pool, org, "휴직 중 반려").await;
    let leave_acks = json!({"privacy_notice_ack": true, "korean_labor_law_ack": true, "payroll_cutoff_ack": true});
    let (status, body) = ctx
        .event(on_leave, ev("LEAVE_OF_ABSENCE", leave_acks))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let case = ctx.report_exit(on_leave).await;
    let (status, body) = ctx
        .exit_action(&case, "confirm", &ctx.token, hr_confirm())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = ctx
        .exit_action(
            &case,
            "confirm",
            &hq_token,
            json!({"hq_confirmation": true}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "HQ_CONFIRMED");
    cancel_conflict(
        ctx.exit_action(&case, "cancel", &ctx.token, reason.clone())
            .await,
    );
    let (status, body) = ctx
        .exit_action(&case, "reject", &hq_token, reason.clone())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "REJECTED");
    assert_eq!(head(on_leave).await, ("ON_LEAVE".to_owned(), None));
    conflict(
        ctx.exit_action(&case, "reject", &hq_token, reason.clone())
            .await,
    );
    conflict(
        ctx.exit_action(&case, "confirm", &ctx.token, json!({}))
            .await,
    );

    // --- Rejecting a SETTLEMENT_READY case voids its settlement package. ---
    assert_eq!(
        ctx.settlement_counts().await,
        (json!(0), json!(0), json!(0)),
        "closed cases count nothing"
    );
    let ready = seed_employee(&pool, org, "정산 후 반려").await;
    sqlx::query("UPDATE employees SET hire_date = '2020-01-01' WHERE id = $1")
        .bind(ready)
        .execute(&pool)
        .await
        .unwrap();
    let case = ctx.report_exit(ready).await;
    let (status, body) = ctx
        .exit_action(&case, "confirm", &ctx.token, hr_confirm())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = ctx
        .exit_action(
            &case,
            "confirm",
            &hq_token,
            json!({"hq_confirmation": true, "settlement_input": settlement.clone()}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "SETTLEMENT_READY");
    assert_eq!(
        ctx.settlement_counts().await,
        (json!(0), json!(1), json!(0))
    );
    let (status, body) = ctx
        .exit_action(&case, "reject", &hq_token, reason.clone())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "REJECTED");
    assert!(body["settlement_package"].is_null(), "{body}");
    assert_eq!(
        ctx.settlement_counts().await,
        (json!(0), json!(0), json!(0))
    );
    let packages: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM employee_exit_settlement_packages WHERE exit_case_id = $1::uuid",
    )
    .bind(&case)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(packages, 0);

    // --- Full path to SUBMITTED, which is terminal. ---
    let leaver = seed_employee(&pool, org, "정상 퇴사").await;
    sqlx::query("UPDATE employees SET hire_date = '2020-01-01' WHERE id = $1")
        .bind(leaver)
        .execute(&pool)
        .await
        .unwrap();
    let case = ctx.report_exit(leaver).await;
    let (status, body) = ctx
        .exit_action(
            &case,
            "confirm",
            &ctx.token,
            json!({"settlement_input": settlement.clone(), "signoffs": all_acks()}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["status"], "HR_CONFIRMED",
        "a complete settlement does not skip HQ"
    );
    let (status, body) = ctx
        .exit_action(
            &case,
            "confirm",
            &hq_token,
            json!({"hq_confirmation": true, "settlement_input": settlement}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "SETTLEMENT_READY");
    let (status, body) = ctx
        .exit_action(&case, "approval-draft", &ctx.token, json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "APPROVAL_DRAFTED");
    let (status, body) = ctx
        .exit_action(&case, "approval-draft", &ctx.token, json!({"submit": true}))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "SUBMITTED");
    for (action, body) in [
        ("confirm", json!({})),
        ("approval-draft", json!({"submit": true})),
        ("reject", reason.clone()),
    ] {
        conflict(ctx.exit_action(&case, action, &ctx.token, body).await);
    }
    cancel_conflict(
        ctx.exit_action(&case, "cancel", &ctx.token, reason.clone())
            .await,
    );
    assert_eq!(head(leaver).await.0, "EXITED");
    // An EXITED employee cannot be reported again.
    let (status, body) = ctx
        .send(
            "POST",
            "/api/v1/hr/exit-cases",
            &ctx.token,
            Some("stage-d-exit-exited-key-01"),
            None,
            Some(json!({"employee_id": leaver, "effective_exit_date": "2099-07-31", "site_manager_note": "재보고"})),
        )
        .await;
    conflict((status, body));
}
