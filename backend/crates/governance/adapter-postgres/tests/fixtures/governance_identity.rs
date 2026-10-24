// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn governance_refuses_unlinked_reviewed_and_bootstrap_people(pool: PgPool) {
    seed_org(&pool, ORG_A, "np-verified").await;
    let maker = seed_user(&pool, ORG_A, "Maker").await;
    let checker = seed_user(&pool, ORG_A, "Checker").await;
    let cases = person_fixtures::unverified_decision_parties(&pool, maker, checker).await;
    let store = PgGovernanceStore::new(runtime_role_pool(&pool).await);
    let valid = [maker, checker];
    for (case, maker, checker) in cases {
        for subject in [maker, checker].into_iter().filter(|u| !valid.contains(u)) {
            let refused = scope_org(
                OrgId::from_uuid(ORG_A),
                store.create_approval(CreateApprovalCommand {
                    requester: subject,
                    request_ref: Uuid::new_v4(),
                    kind: NATURAL_PERSON_KIND.to_owned(),
                    target_ref: None,
                    payload_summary: json!({}),
                    trace: trace(),
                    occurred_at: now(),
                }),
            )
            .await
            .unwrap_err();
            assert!(
                matches!(refused, console_governance_adapter_postgres::PgGovernanceError::Domain(ref e)
                if e.code==Some("governance.refuse.identity_unbound")),
                "{case}"
            );
        }
        let refused = scope_org(
            OrgId::from_uuid(ORG_A),
            store.decide_approval(DecideApprovalCommand {
                approver: checker,
                requested_by: maker,
                request_ref: Uuid::new_v4(),
                kind: NATURAL_PERSON_KIND.to_owned(),
                target_ref: None,
                decision: ApprovalDecision::Approved,
                trace: trace(),
                occurred_at: now(),
            }),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(refused, console_governance_adapter_postgres::PgGovernanceError::Domain(ref e)
            if e.code==Some("governance.refuse.identity_unbound")),
            "{case}"
        );
    }
    let (decisions, audits): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM gov_approvals), (SELECT count(*) FROM audit_events)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((decisions, audits), (0, 0));
}
