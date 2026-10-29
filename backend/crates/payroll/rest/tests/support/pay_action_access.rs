// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

fn operations(run: Uuid) -> Vec<(&'static str, String, Option<Value>)> {
    let root = format!("/api/v1/payroll/runs/{run}");
    vec![
        ("GET", root.clone(), None),
        ("GET", format!("{root}/close-preflight"), None),
        ("GET", format!("{root}/exceptions"), None),
        ("GET", format!("{root}/payslip-delivery"), None),
        (
            "POST",
            format!("{root}/close-attendance"),
            Some(json!({"attest":true})),
        ),
        ("POST", format!("{root}/calculate"), None),
        (
            "POST",
            format!("{root}/exceptions/{}/resolve", Uuid::new_v4()),
            Some(json!({"action":"ACKNOWLEDGE"})),
        ),
        ("POST", format!("{root}/submit"), None),
        (
            "POST",
            format!("{root}/decision"),
            Some(json!({"decision":"APPROVE"})),
        ),
        ("POST", format!("{root}/withdraw"), None),
        (
            "POST",
            format!("{root}/schedule-disbursement"),
            Some(
                json!({"scheduled_at": (OffsetDateTime::now_utc()+Duration::days(1)).format(&Rfc3339).unwrap()}),
            ),
        ),
        (
            "POST",
            format!("{root}/disbursement/attest"),
            Some(json!({"status":"SUCCEEDED"})),
        ),
        ("POST", format!("{root}/issue-payslips"), None),
    ]
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pay_actions_refuse_legacy_roles_on_existing_and_missing_runs(pool: PgPool) {
    let org = OrgId::one();
    seed_org(&pool, org).await;
    let keys = Keys::generate();
    let rt = runtime_role_pool(&pool).await;
    let actor = seed_user(&pool, org, "EXECUTIVE", None).await;
    let run = seed_run(&pool, org, actor).await;
    for role in ["EXECUTIVE", "SUPER_ADMIN"] {
        let actor = seed_user(&pool, org, role, None).await;
        let token = keys.token(&pool, actor, org, role).await;
        for target in [Uuid::new_v4(), run] {
            for (method, uri, body) in operations(target) {
                let (status, body) = send(&rt, &keys, method, &uri, &token, body).await;
                assert_eq!(
                    status,
                    StatusCode::FORBIDDEN,
                    "{role} {method} {uri}: {body}"
                );
                assert_eq!(body["error"]["code"], "forbidden");
            }
        }
        for (suffix, payload) in [
            ("close-attendance", json!({"attest": false})),
            ("schedule-disbursement", json!({"scheduled_at": "invalid"})),
        ] {
            let (status, body) = send(
                &rt,
                &keys,
                "POST",
                &format!("/api/v1/payroll/runs/{run}/{suffix}"),
                &token,
                Some(payload),
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{suffix}: {body}");
        }
        let (status, body) = send(
            &rt,
            &keys,
            "GET",
            "/api/v1/payroll/payslips/me",
            &token,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        for (method, uri, body) in [
            (
                "GET",
                format!(
                    "/api/v1/payroll/employees/{}/payslip-draft?period=2026-07",
                    Uuid::new_v4()
                ),
                None,
            ),
            (
                "POST",
                format!(
                    "/api/v1/payroll/employees/{}/contract-wages",
                    Uuid::new_v4()
                ),
                Some(
                    json!({"effective_from":"2026-07-01","wage_kind":"MONTHLY","amount_won":3000000,"monthly_standard_hours":209}),
                ),
            ),
        ] {
            let (status, body) = send(&rt, &keys, method, &uri, &token, body).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}: {body}");
        }
    }
    let audits: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE action LIKE 'payroll_run.%'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(audits, 0, "denied requests cannot audit or mutate");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn member_pay_edit_allows_commands_and_revocation_is_immediate(pool: PgPool) {
    let org = OrgId::one();
    seed_org(&pool, org).await;
    let keys = Keys::generate();
    let rt = runtime_role_pool(&pool).await;
    let actor = seed_user(&pool, org, "MEMBER", None).await;
    let token = keys.token(&pool, actor, org, "MEMBER").await;
    let grant = pay_view::grant_manage(&pool, org, actor, None).await;
    for (method, uri, body) in operations(Uuid::new_v4()) {
        let (status, body) = send(&rt, &keys, method, &uri, &token, body).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {uri}: {body}");
        assert_eq!(body["error"]["code"], "not_found");
    }
    // rls-arming: ok owner revokes fixture access between same-session requests.
    sqlx::query(
        "UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=$2 WHERE id=$1",
    )
    .bind(grant)
    .bind(actor.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    for (method, uri, body) in operations(Uuid::new_v4()) {
        let (status, body) = send(&rt, &keys, method, &uri, &token, body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}: {body}");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pay_view_and_entity_edit_never_authorize_run_commands(pool: PgPool) {
    let org = OrgId::one();
    seed_org(&pool, org).await;
    let keys = Keys::generate();
    let rt = runtime_role_pool(&pool).await;
    let reader = seed_user(&pool, org, "MEMBER", None).await;
    pay_view::grant_view(&pool, org, reader, None).await;
    let entity_actor = seed_user(&pool, org, "EXECUTIVE", None).await;
    let entity = Uuid::new_v4();
    // rls-arming: ok owner seeds a legal entity for a narrower grant.
    sqlx::query("INSERT INTO legal_entities (org_id,id,needs_confirmation,created_change_mode) VALUES ($1,$2,true,'MIGRATION')")
        .bind(org.as_uuid()).bind(entity).execute(&pool).await.unwrap();
    pay_view::grant_manage(&pool, org, entity_actor, Some(entity)).await;
    for (actor, role) in [(reader, "MEMBER"), (entity_actor, "EXECUTIVE")] {
        let token = keys.token(&pool, actor, org, role).await;
        for (method, uri, body) in operations(Uuid::new_v4()) {
            let (status, body) = send(&rt, &keys, method, &uri, &token, body).await;
            let expected = if actor == reader && method == "GET" {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::FORBIDDEN
            };
            assert_eq!(status, expected, "{method} {uri}: {body}");
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn lifecycle_writes_deny_without_leakage_and_cross_tenant_is_invisible(pool: PgPool) {
    let keys = Keys::generate();
    let rt = runtime_role_pool(&pool).await;
    let org_a = OrgId::one();
    seed_org(&pool, org_a).await;
    let org_b = OrgId::from_uuid(Uuid::new_v4());
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, 'org-b', 'Org B')")
        .bind(*org_b.as_uuid())
        .execute(&pool)
        .await
        .unwrap();

    let stager = seed_user(&pool, org_a, "EXECUTIVE", None).await;
    let run = seed_run(&pool, org_a, stager).await;

    // MEMBER and built-in ADMIN (the write tier is EXECUTIVE/SUPER_ADMIN or a
    // custom org-wide PBAC grant): 403, and the same 403 whether or not the
    // run exists — no existence oracle.
    for role in ["MEMBER", "ADMIN"] {
        let user = seed_user(&pool, org_a, role, None).await;
        let token = keys.token(&pool, user, org_a, role).await;
        for target in [run, Uuid::new_v4()] {
            let (status, denied) = send(
                &rt,
                &keys,
                "POST",
                &format!("/api/v1/payroll/runs/{target}/calculate"),
                &token,
                None,
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{role}: {denied}");
            assert_eq!(denied["error"]["code"], "forbidden");
        }
    }

    // An org-B EXECUTIVE: org A's run is indistinguishable from a missing one
    // on both the read and the write path (RLS deny-by-omission).
    let outsider = seed_user(&pool, org_b, "EXECUTIVE", None).await;
    pay_view::grant_manage(&pool, org_b, outsider, None).await;
    let outsider_token = keys.token(&pool, outsider, org_b, "EXECUTIVE").await;
    for (method, uri) in [
        ("GET", format!("/api/v1/payroll/runs/{run}")),
        ("GET", format!("/api/v1/payroll/runs/{run}/close-preflight")),
        ("GET", format!("/api/v1/payroll/runs/{run}/exceptions")),
        ("POST", format!("/api/v1/payroll/runs/{run}/calculate")),
        ("POST", format!("/api/v1/payroll/runs/{run}/submit")),
    ] {
        let (status, body) = send(&rt, &keys, method, &uri, &outsider_token, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {uri}: {body}");
        assert_eq!(body["error"]["code"], "not_found");
    }

    // The denied probes must not have advanced the run.
    let status: String = sqlx::query_scalar("SELECT status FROM payroll_draft_runs WHERE id = $1")
        .bind(run)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        status, "BLOCKED_LEGAL_GATE",
        "denied probes must not advance the create_run status"
    );
    let probe_audits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE action LIKE 'payroll_run.%' AND target_id = $1",
    )
    .bind(run.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        probe_audits, 0,
        "denied probes must not commit audit events"
    );
}
