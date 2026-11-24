// SPDX-License-Identifier: LicenseRef-Proprietary
//! The ontology action path does not pass through the payroll REST gate, so a
//! decision on a sensitive pay group's run is refused by the port itself
//! without sensitive:edit, exactly as a decision on a run that does not exist.
use super::*;

#[path = "../../../../payroll/rest/tests/fixtures/pay_view.rs"]
mod pay_view;

/// A legal entity's sensitive pay group with one run awaiting decision, seeded by the owner.
async fn submitted_sensitive_run(owner: &PgPool, org: OrgId, submitter: UserId) -> Uuid {
    sqlx::query_scalar(
        "WITH entity AS (INSERT INTO legal_entities (org_id, id, needs_confirmation, created_change_mode) \
           VALUES ($1, gen_random_uuid(), true, 'MIGRATION') RETURNING id), \
         grp AS (INSERT INTO pay_groups (org_id, id, legal_entity_id, name, pay_date_rule, base_period, \
           variable_period, proration, channel, sensitive, pay_basis_allowed) \
           SELECT $1, gen_random_uuid(), id, 'Executive pay', \
             '{\"day\":\"LAST_DAY\",\"month_offset\":0,\"non_business_day\":\"PREVIOUS\"}', \
             '{\"start_day\":\"FIRST\",\"month_offset\":0}', '{\"start_day\":16,\"month_offset\":-1}', \
             'CALENDAR_DAYS', 'ATTESTATION_ONLY', true, ARRAY['MONTHLY'] FROM entity RETURNING id) \
         INSERT INTO payroll_draft_runs (org_id, pay_group_id, kind, attribution_month, pay_date, \
           period_start, period_end, variable_period_start, variable_period_end, source_label, status, \
           submitted_by, submitted_at) \
         SELECT $1, id, 'REGULAR', DATE '2026-07-01', DATE '2026-07-31', DATE '2026-07-01', \
           DATE '2026-07-31', DATE '2026-06-16', DATE '2026-07-15', 'sensitive-run', 'SUBMITTED', $2, \
           now() - interval '1 minute' FROM grp RETURNING id",
    )
    .bind(org.as_uuid())
    .bind(submitter.as_uuid())
    .fetch_one(owner)
    .await
    .unwrap()
}

async fn status(owner: &PgPool, run: Uuid) -> String {
    sqlx::query_scalar("SELECT status FROM payroll_draft_runs WHERE id = $1")
        .bind(run)
        .fetch_one(owner)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_decision_on_a_sensitive_groups_run_needs_edit_clearance(owner: PgPool) {
    let org = OrgId::new();
    seed_org(&owner, *org.as_uuid(), "pay-run-clearance").await;
    let submitter = seed_user(&owner, *org.as_uuid(), "pay-run-submitter").await;
    let decider = seed_user(&owner, *org.as_uuid(), "pay-run-decider").await;
    for user in [submitter, decider] {
        person_fixtures::bind_user_to_distinct_person(&owner, user).await;
    }
    pay_view::grant_manage(&owner, org, decider, None).await;
    let run = submitted_sensitive_run(&owner, org, submitter).await;
    let pay_run_type = seed_canonical_org_actions(
        &owner,
        org,
        submitter,
        "canonical.pay_run",
        "Pay run",
        "payroll_draft_runs",
        "id",
        "label",
        "Label",
        &[("decide_run", DispatchTarget::PayrollDecideRun.as_str())],
    )
    .await;
    let rt = runtime_role_pool(&owner).await;
    let state = OntologyRestState::new(
        PgOntologyStore::new(rt.clone()).with_command_pool(command_role_pool(&owner).await),
        PgInstanceStore::new(rt.clone()),
        PgGovernanceStore::new(rt.clone()),
        None,
    )
    .with_projected_dispatch(
        ProjectedDispatchRegistry::new()
            .register_port(PgPayRunPort::new(rt, tokio::runtime::Handle::current())),
    );
    // The refusal with the run's own id masked, so a hidden run and a missing one
    // compare by everything else.
    let decide = |run_id: Uuid| {
        let principal = super_admin(decider, org);
        let state = state.clone();
        console_platform_request_context::scope_org(org, async move {
            let command = ActionCommand {
                object_type_id: pay_run_type,
                instance_id: Some(InstanceId::from_uuid(run_id)),
                title: None,
                params: json!({ "run_id": run_id, "decision": "APPROVE" }),
                reason: Some("pay run decision".to_owned()),
                valid_from: Some(AT),
                checklist_all_acknowledged: None,
                four_eyes_request_ref: None,
                command_id: Some(Uuid::new_v4()),
                expected_revision: None,
            };
            let outcome = state
                .execute_action(&principal, "decide_run", command)
                .await;
            outcome
                .map(drop)
                .map_err(|error| format!("{error:?}").replace(&run_id.to_string(), "RUN"))
        })
    };
    let hidden = decide(run).await;
    let absent = decide(Uuid::new_v4()).await;
    let unmoved = status(&owner, run).await;
    pay_view::grant_sensitive(&owner, org, decider, None, "edit").await;
    let cleared = decide(run).await;
    assert_eq!(
        (
            hidden.is_err() && hidden == absent,
            unmoved,
            cleared,
            status(&owner, run).await
        ),
        (true, "SUBMITTED".to_owned(), Ok(()), "APPROVED".to_owned()),
        "{hidden:?} / {absent:?}"
    );
}
