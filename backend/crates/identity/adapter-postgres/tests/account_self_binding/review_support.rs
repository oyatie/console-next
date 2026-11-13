// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_identity_adapter_postgres::self_binding_review::ReviewDecision;
use console_platform_auth::{PasskeyAuthenticationCredential, VerifiedStepUp};
use second_person_support::access::{CLOSE, Grant, go_live, grant};

pub(super) async fn proof(store: &PgOrgStore, actor: UserId) -> VerifiedStepUp {
    let mut key = SoftKey::enroll(store.pool(), OrgId::one(), actor).await;
    let assertion = key.step_up(store.pool()).await;
    passkey_service()
        .verify_step_up_proof_for_user(
            store.pool(),
            serde_json::from_value(assertion["ceremony_id"].clone()).unwrap(),
            serde_json::from_value::<PasskeyAuthenticationCredential>(
                assertion["credential"].clone(),
            )
            .unwrap(),
            *actor.as_uuid(),
        )
        .await
        .unwrap()
}

pub(super) async fn review(
    store: &PgOrgStore,
    actor: UserId,
    receipt: Uuid,
    decision: ReviewDecision,
) -> Result<(), PgOrgError> {
    let proof = proof(store, actor).await;
    scope_org(
        OrgId::one(),
        store.review_self_binding(receipt, decision, proof, TraceContext::generate()),
    )
    .await
}

pub(super) async fn attested(pool: &PgPool) -> (PgOrgStore, UserId, Uuid, Uuid) {
    let (store, actor, employee, mut key) = fixture(pool).await;
    sqlx::query("UPDATE employees SET identity_review_required=false WHERE id=$1")
        .bind(employee)
        .execute(pool)
        .await
        .unwrap();
    let proof = envelope(store.pool(), actor, employee, &mut key).await;
    let receipt = bind(&store, actor, employee, proof).await.unwrap();
    (store, actor, employee, receipt)
}

pub(super) async fn reviewer(pool: &PgPool, actor: UserId, bound: bool, permitted: bool) -> UserId {
    let user = second_person_support::holder(pool, None, &[], false, 0, false).await;
    if bound {
        let employee = employee(pool).await;
        sqlx::query("UPDATE employees SET identity_review_required=false WHERE id=$1")
            .bind(employee)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("UPDATE users SET employee_id=$2 WHERE id=$1")
            .bind(user)
            .bind(employee)
            .execute(pool)
            .await
            .unwrap();
    }
    if permitted {
        grant(
            pool,
            second_person_support::org(),
            *actor.as_uuid(),
            user,
            Grant {
                domain: "access",
                level: "edit",
                ..CLOSE
            },
        )
        .await;
    }
    let setup: bool = sqlx::query_scalar("SELECT phase='SETUP' FROM tenant_phase WHERE org_id=$1")
        .bind(OrgId::one().as_uuid())
        .fetch_one(pool)
        .await
        .unwrap();
    if setup {
        go_live(pool, second_person_support::org(), *actor.as_uuid()).await;
    }
    UserId::from_uuid(user)
}

pub(super) async fn decisions(pool: &PgPool, receipt: Uuid) -> (i64, i64) {
    sqlx::query_as("SELECT (SELECT count(*) FROM account_link_self_reviews WHERE attestation_id=$1), \
        (SELECT count(*) FROM audit_events WHERE after_snap->>'self_attestation_id'=$1::text AND action IN ('account_link.confirmed','account_link.revoked'))")
        .bind(receipt).fetch_one(pool).await.unwrap()
}
