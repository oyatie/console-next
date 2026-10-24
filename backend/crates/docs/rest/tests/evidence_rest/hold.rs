// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
#[path = "../../../../../test-support/person_fixtures.rs"]
mod person_fixtures;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn hold_blocks_disposal_and_release_requires_a_distinct_approver(owner_pool: PgPool) {
    let rt = rt_pool(&owner_pool).await;
    seed_org_rls_off(&owner_pool, ORG_A, "A").await;
    let requester = seed_admin_user_rls_off(&owner_pool, ORG_A).await;
    let approver = seed_admin_user_rls_off(&owner_pool, ORG_A).await;
    for user in [requester, approver] {
        person_fixtures::bind_user_to_distinct_person(&owner_pool, user).await;
    }
    let st = state(rt, StubWormStore::default());
    let org = OrgId::from_uuid(ORG_A);

    let digest = "dd".repeat(32);
    let id = console_platform_request_context::scope_org(org, async {
        register_object(st.docs_store(), requester, &digest, "worm/h-1", "Held").await
    })
    .await;

    // Apply a legal hold, then disposal must be BLOCKED.
    let hold = console_platform_request_context::scope_org(org, async {
        st.apply_hold(ApplyLegalHoldCommand {
            actor: requester,
            evidence_object_id: id,
            case_ref: "CASE-1".to_owned(),
            basis: "litigation".to_owned(),
            reason: "preserve".to_owned(),
            trace: TraceContext::generate(),
            occurred_at: now(),
        })
        .await
    })
    .await
    .expect("apply_hold succeeds");

    let dispose_blocked = console_platform_request_context::scope_org(org, async {
        st.docs_store()
            .dispose_object(DisposeEvidenceObjectCommand {
                actor: requester,
                evidence_object_id: id,
                reason: "cleanup".to_owned(),
                trace: TraceContext::generate(),
                occurred_at: now(),
            })
            .await
    })
    .await;
    assert!(
        dispose_blocked.is_err(),
        "an ACTIVE legal hold must block disposal"
    );

    // Release with NO four-eyes approval is refused (fail-closed).
    let refused = console_platform_request_context::scope_org(org, async {
        st.release_hold(
            Uuid::new_v4(),
            ReleaseLegalHoldCommand {
                actor: approver,
                evidence_object_id: id,
                hold_id: hold.id,
                release_reason: "cleared".to_owned(),
                trace: TraceContext::generate(),
                occurred_at: now(),
            },
        )
        .await
    })
    .await;
    assert!(
        matches!(refused, Err(HoldError::FourEyesRequired)),
        "release without a distinct-approver approval is refused"
    );

    // Record a DISTINCT approver's approval, then release succeeds.
    let request_ref = Uuid::new_v4();
    console_platform_request_context::scope_org(org, async {
        st.governance_store()
            .decide_approval(DecideApprovalCommand {
                approver,
                request_ref,
                // Must match the release gate's server-derived binding: the console
                // kind `evidence.hold.release` bound to the hold being released.
                kind: "evidence.hold.release".to_owned(),
                requested_by: requester,
                target_ref: Some(*hold.id.as_uuid()),
                decision: ApprovalDecision::Approved,
                trace: TraceContext::generate(),
                occurred_at: now(),
            })
            .await
    })
    .await
    .expect("a distinct approver records an approval");

    console_platform_request_context::scope_org(org, async {
        st.release_hold(
            request_ref,
            ReleaseLegalHoldCommand {
                actor: approver,
                evidence_object_id: id,
                hold_id: hold.id,
                release_reason: "cleared".to_owned(),
                trace: TraceContext::generate(),
                occurred_at: now(),
            },
        )
        .await
    })
    .await
    .expect("release succeeds once a distinct approver has approved");

    // With the hold released, disposal is now permitted.
    console_platform_request_context::scope_org(org, async {
        st.docs_store()
            .dispose_object(DisposeEvidenceObjectCommand {
                actor: requester,
                evidence_object_id: id,
                reason: "cleanup".to_owned(),
                trace: TraceContext::generate(),
                occurred_at: now(),
            })
            .await
    })
    .await
    .expect("disposal is unblocked after the hold is released");
}
