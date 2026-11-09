// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[path = "../../../crates/hr/adapter-postgres/tests/support/lifecycle_grant.rs"]
mod lifecycle_grant;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn bulk_appointment_is_all_or_nothing_audited_and_idempotent(pool: PgPool) {
    let (ctx, org, admin) = setup(&pool).await;
    lifecycle_grant::grant(&pool, org, *admin.as_uuid()).await;
    let first = seed_employee(&pool, org, "일괄 1").await;
    let second = seed_employee(&pool, org, "일괄 2").await;
    let on_leave = seed_employee(&pool, org, "휴직 직원").await;
    let leave_acks = json!({"privacy_notice_ack": true, "korean_labor_law_ack": true, "payroll_cutoff_ack": true});
    let (status, body) = ctx
        .event(on_leave, ev("LEAVE_OF_ABSENCE", leave_acks))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let team = seed_org_unit(&pool, org, admin, "정비2팀").await;
    let bulk = |key: &str, body: Value| {
        let key = key.to_owned();
        let ctx = &ctx;
        async move {
            ctx.send(
                "POST",
                "/api/v1/employees/lifecycle-events/bulk",
                &ctx.token,
                Some(&key),
                None,
                Some(body),
            )
            .await
        }
    };
    let transfer = |ids: Vec<Uuid>| {
        json!({
            "event_type": "TRANSFER",
            "employee_ids": ids,
            "to_org_unit_id": team,
            "effective_date": OffsetDateTime::now_utc().date().to_string(),
            "comment": "일괄 발령",
            "signoffs": base(),
        })
    };
    let recorded = |pool: PgPool| async move {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM employee_lifecycle_events WHERE event_type = 'TRANSFER'",
        )
        .fetch_one(&pool)
        .await
        .unwrap()
    };

    // One refused employee (ON_LEAVE) refuses the whole batch and names it.
    let (status, body) = bulk(
        "bulk-refused-key-0001",
        transfer(vec![first, on_leave, second]),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "bulk_lifecycle_refused");
    let refusals = body["error"]["refusals"].as_array().unwrap();
    assert_eq!(refusals.len(), 1, "{body}");
    assert_eq!(refusals[0]["employee_id"], on_leave.to_string());
    assert_eq!(refusals[0]["code"], "invalid_transition");
    assert_eq!(
        recorded(pool.clone()).await,
        0,
        "nothing is written on refusal"
    );

    // A missing employee is a not_found refusal, not a server error.
    let (status, body) = bulk(
        "bulk-missing-key-00001",
        transfer(vec![first, Uuid::new_v4()]),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["refusals"][0]["code"], "not_found", "{body}");
    // Each refusal message is localized like the top-level one; codes stay.
    let missing = Uuid::new_v4();
    let (status, korean) = ctx
        .send(
            "POST",
            "/api/v1/employees/lifecycle-events/bulk",
            &ctx.token,
            Some("bulk-missing-key-ko-001"),
            Some("ko"),
            Some(transfer(vec![first, missing])),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{korean}");
    let refusal = &korean["error"]["refusals"][0];
    assert_eq!(refusal["code"], "not_found", "{korean}");
    assert_ne!(
        refusal["message"], body["error"]["refusals"][0]["message"],
        "{korean}"
    );
    assert!(
        refusal["message"]
            .as_str()
            .unwrap()
            .chars()
            .any(|c| ('가'..='힣').contains(&c)),
        "{korean}"
    );

    // A repeated employee and a missing key are refused up front.
    let (status, _) = bulk("bulk-repeat-key-00001", transfer(vec![first, first])).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, body) = ctx
        .send(
            "POST",
            "/api/v1/employees/lifecycle-events/bulk",
            &ctx.token,
            None,
            None,
            Some(transfer(vec![first])),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");

    // All valid: every employee moves, one batch id, per-employee audits.
    let key = "bulk-applied-key-0001";
    let (status, body) = bulk(key, transfer(vec![second, first])).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let batch = body["batch_id"].as_str().unwrap().to_owned();
    let items = body["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["employee_id"], second.to_string(), "request order");
    for item in items {
        assert_eq!(item["batch_id"], batch);
        assert_eq!(item["to_org_unit"], "정비2팀");
    }
    let bound: i64 = sqlx::query_scalar("SELECT count(*) FROM employees WHERE org_unit_id = $1")
        .bind(team)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(bound, 2);
    let audits: (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE action = 'employee.lifecycle.record' AND after_snap->>'batch_id' = $1), \
                count(*) FILTER (WHERE action = 'employee.lifecycle.bulk' AND target_id = $1) \
         FROM audit_events",
    )
    .bind(&batch)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audits, (2, 1));

    // Exact replay returns the same batch; a now-noop re-run is refused.
    let (status, replay) = bulk(key, transfer(vec![second, first])).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["batch_id"], batch);
    assert_eq!(recorded(pool.clone()).await, 2);
    let (status, body) = bulk("bulk-noop-key-000001", transfer(vec![first])).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["refusals"][0]["code"], "lifecycle_noop");
}
