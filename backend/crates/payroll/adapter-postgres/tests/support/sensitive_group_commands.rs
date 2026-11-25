// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_ontology_canonical_domain::{CanonicalPort, CommandId};
use console_payroll_adapter_postgres::pay_run::{PayRunCommand, PayRunQuery, PgPayRunPort};
use console_platform_authz::{Feature, cedar_pbac::visible::load_facts};
use console_platform_db::with_org_conn;

async fn allowed(pool: &PgPool, org: OrgId, actor: UserId, action: Feature) -> Vec<Uuid> {
    let store = PgPayrollStore::new(pool.clone());
    with_org_conn::<_, _, console_payroll_adapter_postgres::PgPayrollError>(pool, org, move |tx| {
        Box::pin(async move {
            let facts = load_facts(tx, org, *actor.as_uuid()).await?;
            Ok(facts.visible_pay_groups(tx, action, &store).await?)
        })
    })
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn stored_sensitive_flag_controls_command_authority_not_just_read_authority(pool: PgPool) {
    let org = OrgId::new();
    let actor = seed_org_and_super_admin(&pool, *org.as_uuid(), "sensitive-command").await;
    let entity = entity(&pool, org).await;
    pay_access::grant_manage(&pool, org, actor, None).await;
    let rt = runtime_role_pool(&pool).await;
    let group = PgPayrollStore::new(rt.clone())
        .create_pay_group(org, actor, input(entity))
        .await
        .unwrap();
    assert_eq!(
        allowed(&rt, org, actor, Feature::PayrollRunManage).await,
        vec![group.id]
    );
    // rls-arming: ok owner changes stored sensitivity; callers never supply the decision's flag.
    sqlx::query("UPDATE pay_groups SET sensitive=true WHERE id=$1")
        .bind(group.id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        allowed(&rt, org, actor, Feature::PayrollRunManage)
            .await
            .is_empty()
    );
    assert!(
        allowed(&rt, org, actor, Feature::PayrollRunRead)
            .await
            .is_empty()
    );
    pay_access::grant_sensitive(&pool, org, actor, Some(entity), "view").await;
    assert_eq!(
        allowed(&rt, org, actor, Feature::PayrollRunRead).await,
        vec![group.id]
    );
    assert!(
        allowed(&rt, org, actor, Feature::PayrollRunManage)
            .await
            .is_empty()
    );
    let clearance = pay_access::grant_sensitive(&pool, org, actor, Some(entity), "edit").await;
    assert_eq!(
        allowed(&rt, org, actor, Feature::PayrollRunManage).await,
        vec![group.id]
    );
    assert!(
        allowed(&rt, org, actor, Feature::EmployeeDirectoryManage)
            .await
            .is_empty()
    );
    // rls-arming: ok revoke edit without removing view, then reuse the same account.
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE id=$1")
        .bind(clearance).execute(&pool).await.unwrap();
    assert!(
        allowed(&rt, org, actor, Feature::PayrollRunManage)
            .await
            .is_empty()
    );
    assert_eq!(
        allowed(&rt, org, actor, Feature::PayrollRunRead).await,
        vec![group.id]
    );
    let store = PgPayrollStore::new(rt.clone());
    with_org_conn::<_, _, console_payroll_adapter_postgres::PgPayrollError>(&rt, org, move |tx| {
        Box::pin(async move {
            let facts = load_facts(tx, org, *actor.as_uuid()).await?;
            sqlx::query("RESET app.current_org")
                .execute(tx.as_mut())
                .await?;
            let refused = facts
                .visible_pay_groups(tx, Feature::PayrollRunRead, &store)
                .await
                .unwrap_err();
            assert_eq!(refused.kind, ErrorKind::Forbidden);
            Ok(())
        })
    })
    .await
    .unwrap();
}

/// A run of a sensitive pay group, calculated and ready to submit, seeded by the owner.
async fn calculated_run(pool: &PgPool, org: OrgId, group: Uuid) -> Uuid {
    // rls-arming: ok owner seeds the run, one line and its calculation; the port uses console_rt.
    sqlx::query_scalar("WITH run AS (INSERT INTO payroll_draft_runs (org_id,pay_group_id,kind,attribution_month,pay_date,period_start,period_end,variable_period_start,variable_period_end,source_label,status) VALUES ($1,$2,'REGULAR',DATE '2026-06-01',DATE '2026-06-30',DATE '2026-06-01',DATE '2026-06-30',DATE '2026-05-16',DATE '2026-06-15','port-run','CALCULATED') RETURNING org_id,id), line AS (INSERT INTO payroll_draft_lines (org_id,run_id,employee_source_key,employee_display_name,employee_company) SELECT org_id,id,'calculated','Calculated','SAE' FROM run RETURNING org_id,run_id,id) INSERT INTO payroll_line_calculations (org_id,run_id,line_id,version,gross_won,deductions,total_deductions_won,net_won,tax_table_version) SELECT org_id,run_id,id,1,0,'[]',0,0,'fixture' FROM line RETURNING run_id")
        .bind(org.as_uuid()).bind(group).fetch_one(pool).await.unwrap()
}

/// One command through the canonical port; `execute` is synchronous, so it runs
/// off the async worker. The error is kept as its debug form to compare refusals.
async fn dispatch(
    port: &PgPayRunPort,
    org: OrgId,
    actor: UserId,
    query: PayRunQuery,
) -> Result<(), String> {
    let (port, command) = (
        port.clone(),
        PayRunCommand {
            org_id: org,
            command_id: CommandId::from_uuid(Uuid::new_v4()),
            actor_id: actor,
            query,
            action_key: "revise".to_owned(),
            object_type_id: Uuid::nil(),
        },
    );
    let outcome = tokio::task::spawn_blocking(move || port.execute(&command))
        .await
        .unwrap();
    outcome.map(drop).map_err(|error| format!("{error:?}"))
}

async fn status(pool: &PgPool, run: Uuid) -> String {
    // rls-arming: ok owner reads the run a refused command may not move.
    sqlx::query_scalar("SELECT status FROM payroll_draft_runs WHERE id=$1")
        .bind(run)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// The ontology action path does not pass through the REST gate, so the port
/// itself refuses a submit or decision on a sensitive group's run without
/// tenant pay:edit or without sensitive:edit, exactly as it refuses a run that
/// does not exist.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn port_commands_on_a_sensitive_groups_run_need_edit_clearance(pool: PgPool) {
    let org = OrgId::new();
    let submitter = seed_org_and_super_admin(&pool, *org.as_uuid(), "port-submitter").await;
    let decider = seed_active_user(&pool, *org.as_uuid(), "MEMBER", "port-decider").await;
    for actor in [submitter, decider] {
        person_fixtures::bind_user_to_distinct_person(&pool, actor).await;
        pay_access::grant_manage(&pool, org, actor, None).await;
    }
    let entity = entity(&pool, org).await;
    let rt = runtime_role_pool(&pool).await;
    let store = PgPayrollStore::new(rt.clone());
    let group = store
        .create_pay_group(org, submitter, input(entity))
        .await
        .unwrap();
    // rls-arming: ok owner marks the group sensitive, as in the test above.
    sqlx::query("UPDATE pay_groups SET sensitive=true WHERE id=$1")
        .bind(group.id)
        .execute(&pool)
        .await
        .unwrap();
    let run = calculated_run(&pool, org, group.id).await;
    let port = PgPayRunPort::new(rt, tokio::runtime::Handle::current());
    let submit = |run_id| PayRunQuery::SubmitRun { run_id };
    let decide = |run_id| PayRunQuery::DecideRun {
        run_id,
        decision: "APPROVE".to_owned(),
        reason: None,
    };
    // Entity-scoped pay:edit, even with that entity's sensitive:edit, is not the
    // tenant pay access REST requires of every run command.
    let narrow = seed_active_user(&pool, *org.as_uuid(), "MEMBER", "port-narrow").await;
    person_fixtures::bind_user_to_distinct_person(&pool, narrow).await;
    pay_access::grant_manage(&pool, org, narrow, Some(entity)).await;
    pay_access::grant_sensitive(&pool, org, narrow, Some(entity), "edit").await;
    let scoped = dispatch(&port, org, narrow, submit(run)).await;
    let scoped = (scoped, status(&pool, run).await);
    let unknown = Uuid::new_v4();
    let mut steps = Vec::new();
    for (actor, query, missing) in [
        (submitter, submit(run), submit(unknown)),
        (decider, decide(run), decide(unknown)),
    ] {
        let hidden = dispatch(&port, org, actor, query.clone()).await;
        let absent = dispatch(&port, org, actor, missing).await;
        let unmoved = status(&pool, run).await;
        pay_access::grant_sensitive(&pool, org, actor, Some(entity), "edit").await;
        let cleared = dispatch(&port, org, actor, query).await;
        steps.push((hidden == absent, hidden, unmoved, cleared));
    }
    let refused = || Err("Lifecycle(NotFound)".to_owned());
    assert_eq!(
        (scoped, steps, status(&pool, run).await),
        (
            (refused(), "CALCULATED".to_owned()),
            vec![
                (true, refused(), "CALCULATED".to_owned(), Ok(())),
                (true, refused(), "SUBMITTED".to_owned(), Ok(())),
            ],
            "APPROVED".to_owned()
        )
    );
}

/// A run staged from imports has no group to check, but its commands still need
/// tenant pay:edit, as over REST; SUPER_ADMIN alone carries none.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn port_commands_on_an_import_run_need_tenant_pay_edit(pool: PgPool) {
    let org = OrgId::new();
    let admin = seed_org_and_super_admin(&pool, *org.as_uuid(), "import-admin").await;
    let member = seed_active_user(&pool, *org.as_uuid(), "MEMBER", "import-member").await;
    let granted = seed_active_user(&pool, *org.as_uuid(), "MEMBER", "import-granted").await;
    for actor in [admin, member, granted] {
        person_fixtures::bind_user_to_distinct_person(&pool, actor).await;
    }
    pay_access::grant_manage(&pool, org, granted, None).await;
    // rls-arming: ok owner seeds a calculated import run, as calculated_run does.
    let import_run = || async {
        sqlx::query_scalar::<_, Uuid>("WITH run AS (INSERT INTO payroll_draft_runs (org_id,period_start,period_end,source_label,status) VALUES ($1,DATE '2026-06-01',DATE '2026-06-30',$2,'CALCULATED') RETURNING org_id,id), line AS (INSERT INTO payroll_draft_lines (org_id,run_id,employee_source_key,employee_display_name,employee_company) SELECT org_id,id,'calculated','Calculated','SAE' FROM run RETURNING org_id,run_id,id) INSERT INTO payroll_line_calculations (org_id,run_id,line_id,version,gross_won,deductions,total_deductions_won,net_won,tax_table_version) SELECT org_id,run_id,id,1,0,'[]',0,0,'fixture' FROM line RETURNING run_id")
            .bind(org.as_uuid()).bind(format!("import-{}", Uuid::new_v4())).fetch_one(&pool).await.unwrap()
    };
    let rt = runtime_role_pool(&pool).await;
    let mut manageable = Vec::new();
    for actor in [admin, member, granted] {
        let m = with_org_conn::<_, _, console_payroll_adapter_postgres::PgPayrollError>(
            &rt,
            org,
            move |tx| {
                Box::pin(async move {
                    let facts = load_facts(tx, org, *actor.as_uuid()).await?;
                    Ok(
                        console_payroll_adapter_postgres::pay_groups::manageable_pay_groups_in_tx(
                            tx, &facts, org,
                        )
                        .await?,
                    )
                })
            },
        )
        .await
        .unwrap();
        manageable.push(m.is_some());
    }
    let port = PgPayRunPort::new(rt, tokio::runtime::Handle::current());
    let mut outcomes = Vec::new();
    for actor in [admin, member, granted] {
        let run = import_run().await;
        let submitted = dispatch(&port, org, actor, PayRunQuery::SubmitRun { run_id: run }).await;
        outcomes.push((submitted, status(&pool, run).await));
    }
    let refused = || {
        (
            Err("Lifecycle(NotFound)".to_owned()),
            "CALCULATED".to_owned(),
        )
    };
    assert_eq!(
        (manageable, outcomes),
        (
            vec![false, false, true],
            vec![refused(), refused(), (Ok(()), "SUBMITTED".to_owned())]
        )
    );
}
