// SPDX-License-Identifier: LicenseRef-Proprietary
//! A run of a sensitive pay group is readable only with sensitive:view and
//! commandable only with sensitive:edit. Without view it answers exactly as a run
//! that does not exist.
use super::super::*;

/// A run of a sensitive pay group, with one roster line, seeded by the owner.
async fn sensitive_run(pool: &PgPool, org: OrgId) -> Uuid {
    let employee = seed_employee(pool, org, "Alice").await;
    // rls-arming: ok owner seeds the group's legal entity; requests use console_rt.
    let entity: Uuid = sqlx::query_scalar("INSERT INTO legal_entities (org_id,id,needs_confirmation,created_change_mode) VALUES ($1,gen_random_uuid(),true,'MIGRATION') RETURNING id")
        .bind(org.as_uuid()).fetch_one(pool).await.unwrap();
    // rls-arming: ok owner seeds a sensitive pay group.
    let group: Uuid = sqlx::query_scalar("INSERT INTO pay_groups (org_id,id,legal_entity_id,name,pay_date_rule,base_period,variable_period,proration,channel,sensitive,pay_basis_allowed) VALUES ($1,gen_random_uuid(),$2,'임원 급여','{\"day\":\"LAST_DAY\",\"month_offset\":0,\"non_business_day\":\"PREVIOUS\"}','{\"start_day\":\"FIRST\",\"month_offset\":0}','{\"start_day\":16,\"month_offset\":-1}','CALENDAR_DAYS','ATTESTATION_ONLY',true,ARRAY['MONTHLY']) RETURNING id")
        .bind(org.as_uuid()).bind(entity).fetch_one(pool).await.unwrap();
    // rls-arming: ok owner seeds the group's run as run creation stores it.
    let run: Uuid = sqlx::query_scalar("INSERT INTO payroll_draft_runs (org_id,pay_group_id,kind,attribution_month,pay_date,period_start,period_end,variable_period_start,variable_period_end,source_label) VALUES ($1,$2,'REGULAR',DATE '2026-06-01',DATE '2026-06-30',DATE '2026-06-01',DATE '2026-06-30',DATE '2026-05-16',DATE '2026-06-15','sensitive-run') RETURNING id")
        .bind(org.as_uuid()).bind(group).fetch_one(pool).await.unwrap();
    // rls-arming: ok owner seeds the run's roster line.
    sqlx::query("INSERT INTO payroll_draft_lines (org_id,run_id,employee_id,employee_source_key,employee_display_name,employee_company) VALUES ($1,$2,$3,'alice','Alice','SAE')")
        .bind(org.as_uuid()).bind(run).bind(employee).execute(pool).await.unwrap();
    run
}

/// The run's status and its lines, to show that a refused request wrote nothing.
async fn state(pool: &PgPool, run: Uuid) -> (String, Value) {
    // rls-arming: ok owner snapshots the fixture run.
    sqlx::query_as("SELECT r.status, COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM payroll_draft_lines l WHERE l.run_id=r.id),'[]') FROM payroll_draft_runs r WHERE r.id=$1")
        .bind(run).fetch_one(pool).await.unwrap()
}

async fn pay_holder(pool: &PgPool, keys: &Keys, org: OrgId) -> (UserId, String) {
    let actor = seed_user(pool, org, "MEMBER", None).await;
    pay_view::grant_manage(pool, org, actor, None).await;
    (actor, keys.token(pool, actor, org, "MEMBER").await)
}

/// Command refusals carry a fresh operation id per request; mask it so a hidden
/// run and a missing one compare by everything else in the answer.
fn masked((status, mut body): (StatusCode, Value)) -> (StatusCode, Value) {
    if let Some(id) = body.pointer_mut("/error/operation_id") {
        *id = json!("operation");
    }
    (status, body)
}

fn shown(method: &str, uri: &str, (status, body): &(StatusCode, Value)) -> String {
    let body: String = body.to_string().chars().take(160).collect();
    format!("{method} {uri}: {status} {body}")
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_sensitive_group_run_is_not_found_for_a_pay_holder_without_clearance(pool: PgPool) {
    let org = OrgId::one();
    seed_org(&pool, org).await;
    let (keys, rt) = (Keys::generate(), runtime_role_pool(&pool).await);
    let run = sensitive_run(&pool, org).await;
    let (_, token) = pay_holder(&pool, &keys, org).await;
    let before = state(&pool, run).await;
    let mut disclosed = Vec::new();
    let unknown_run = Uuid::new_v4();
    let (mut hidden_ops, mut unknown) = (super::operations(run), super::operations(unknown_run));
    // A body that fails validation must not reach validation on a hidden run.
    for (suffix, invalid) in [
        ("close-attendance", json!({"attest": false})),
        ("schedule-disbursement", json!({"scheduled_at": "invalid"})),
    ] {
        for (target, ops) in [(run, &mut hidden_ops), (unknown_run, &mut unknown)] {
            let uri = format!("/api/v1/payroll/runs/{target}/{suffix}");
            ops.push(("POST", uri, Some(invalid.clone())));
        }
    }
    for ((method, uri, body), (_, missing, missing_body)) in hidden_ops.into_iter().zip(unknown) {
        let hidden = masked(send(&rt, &keys, method, &uri, &token, body).await);
        let absent = masked(send(&rt, &keys, method, &missing, &token, missing_body).await);
        if hidden.0 != StatusCode::NOT_FOUND || hidden != absent {
            disclosed.push(shown(method, &uri, &hidden));
        }
    }
    let (_, listed) = send(&rt, &keys, "GET", "/api/v1/payroll/runs", &token, None).await;
    // rls-arming: ok owner counts the run audits a refused request may not leave.
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action LIKE 'payroll_run.%' AND target_id=$1",
    )
    .bind(run.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        (
            disclosed,
            listed["items"].as_array().map(Vec::len),
            listed["total"].clone(),
            audits,
            state(&pool, run).await
        ),
        (Vec::<String>::new(), Some(0), json!(0), 0, before)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn sensitive_view_clearance_reads_the_run_but_its_commands_are_forbidden(pool: PgPool) {
    let org = OrgId::one();
    seed_org(&pool, org).await;
    let (keys, rt) = (Keys::generate(), runtime_role_pool(&pool).await);
    let run = sensitive_run(&pool, org).await;
    let (actor, token) = pay_holder(&pool, &keys, org).await;
    pay_view::grant_sensitive(&pool, org, actor, None, "view").await;
    let before = state(&pool, run).await;
    let mut unexpected = Vec::new();
    for (method, uri, body) in super::operations(run) {
        let answer = send(&rt, &keys, method, &uri, &token, body).await;
        let expected = if method == "GET" {
            (StatusCode::OK, None)
        } else {
            (StatusCode::FORBIDDEN, Some("forbidden"))
        };
        if (answer.0, answer.1["error"]["code"].as_str()) != expected {
            unexpected.push(shown(method, &uri, &answer));
        }
    }
    let uri = format!("/api/v1/payroll/runs/{run}");
    let (_, detail) = send(&rt, &keys, "GET", &uri, &token, None).await;
    assert_eq!(
        (
            unexpected,
            detail["lines"].as_array().map(Vec::len),
            state(&pool, run).await
        ),
        (Vec::<String>::new(), Some(1), before)
    );
}
