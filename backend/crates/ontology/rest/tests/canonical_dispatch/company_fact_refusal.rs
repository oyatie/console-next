// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_governance_application::{ApprovalDecision, DecideApprovalCommand};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn retired_company_writer_does_not_spend_an_approval(owner: PgPool) {
    let org = OrgId::new();
    seed_org(&owner, *org.as_uuid(), "company-refusal").await;
    let actor = seed_user(&owner, *org.as_uuid(), "company-requester").await;
    let approver = seed_user(&owner, *org.as_uuid(), "company-approver").await;
    for user in [actor, approver] {
        person_fixtures::bind_user_to_distinct_person(&owner, user).await;
    }
    let rt = runtime_role_pool(&owner).await;
    let cmd = command_role_pool(&owner).await;
    let type_id = console_platform_request_context::scope_org(org, async {
        PgOntologyStore::new(owner.clone())
            .with_command_pool(cmd.clone())
            .create_object_type(
                actor,
                CreateObjectTypeDraft {
                    stable_key: "company.retired".into(),
                    title: "법인".into(),
                    title_property_key: None,
                    backing_kind: BackingKind::Projected,
                    backing_table: Some("company_revisions".into()),
                    primary_key_property: Some("org_id".into()),
                    properties: Vec::new(),
                    links: Vec::new(),
                    actions: vec![ActionTypeInput {
                        stable_key: "revise".into(),
                        title: "수정".into(),
                        params_schema: json!({}),
                        edits: json!([]),
                        submission_criteria: json!([]),
                        side_effects: json!([]),
                        dispatch: ActionDispatch::ProjectedUsecase,
                        dispatch_target: Some("company.revise".into()),
                        control_points: json!(["authority", "four_eyes"]),
                    }],
                    analytics: Vec::new(),
                },
                TraceContext::generate(),
                AT,
            )
            .await
            .unwrap()
            .id
    })
    .await;
    let request_ref = Uuid::new_v4();
    console_platform_request_context::scope_org(org, async {
        PgGovernanceStore::new(rt.clone())
            .decide_approval(DecideApprovalCommand {
                approver,
                request_ref,
                kind: "revise".into(),
                requested_by: actor,
                target_ref: Some(*type_id.as_uuid()),
                decision: ApprovalDecision::Approved,
                trace: TraceContext::generate(),
                occurred_at: AT,
            })
            .await
            .unwrap();
    })
    .await;
    let state = OntologyRestState::new(
        PgOntologyStore::new(rt.clone()).with_command_pool(cmd),
        PgInstanceStore::new(rt.clone()),
        PgGovernanceStore::new(rt.clone()),
        None,
    )
    .with_projected_dispatch(
        ProjectedDispatchRegistry::new()
            .register_port(PgCompanyPort::new(rt, tokio::runtime::Handle::current())),
    );
    let error = console_platform_request_context::scope_org(
        org,
        state.execute_action(
            &super_admin(actor, org),
            "revise",
            ActionCommand {
                object_type_id: type_id,
                instance_id: None,
                title: None,
                params: json!({"attributes":{"legal_name":"COSS"}}),
                reason: None,
                valid_from: None,
                checklist_all_acknowledged: None,
                four_eyes_request_ref: Some(request_ref),
                command_id: Some(Uuid::new_v4()),
                expected_revision: None,
            },
        ),
    )
    .await
    .unwrap_err();
    assert!(format!("{error:?}").contains("legal_entity_record_required"));
    let consumptions: i64 =
        sqlx::query_scalar("SELECT count(*) FROM gov_approval_consumptions WHERE org_id=$1")
            .bind(org.as_uuid())
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(consumptions, 0);
}
