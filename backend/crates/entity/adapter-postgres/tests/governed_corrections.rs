#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! ENT-REG after 운영 시작: an identifier correction is admitted only by
//! consuming the BW-06 governed exception for exactly that correction
//! (MR-17), through the port as the composition root wires it.

mod common;
mod corrections_support;

use common::*;
use console_entity_adapter_postgres::{
    CorrectionCover, CorrectionSubject, GovernedCorrectionFuture, GovernedCorrectionPort,
};
use console_entity_domain::correction::IdentifierCorrectionInput;
use console_governance_adapter_postgres::exception::{
    ExceptionRequest, GovernedWrite, consume_exception_conn, get_exception_conn,
    request_exception_conn,
};
use console_governance_domain::exception::{
    ExceptionSettings, FallbackKind, RuleCode, SoleHolderMode, SubjectType,
};
use console_kernel_core::KernelError;
use corrections_support::*;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;

const ORG_A: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0E19);

/// The BW-06 consumer exactly as the composition root wires it.
struct Governance;

impl GovernedCorrectionPort for Governance {
    /// The ops cover is proven through the router (app `entity_ops_correction`).
    fn cover_as_ops<'tx>(
        &self,
        _tx: &'tx mut sqlx::Transaction<'_, sqlx::Postgres>,
        _cover: console_entity_adapter_postgres::OpsCover<'tx>,
    ) -> console_entity_adapter_postgres::OpsCoverFuture<'tx> {
        Box::pin(async { Err(KernelError::internal("not used here")) })
    }

    fn consume<'a>(
        &'a self,
        conn: &'a mut sqlx::PgConnection,
        exception_id: Uuid,
        subject: CorrectionSubject,
        payload: &'a Value,
    ) -> GovernedCorrectionFuture<'a> {
        let kernel = |e: console_governance_adapter_postgres::PgGovernanceError| match e {
            console_governance_adapter_postgres::PgGovernanceError::Domain(k) => k,
            other => KernelError::internal(other.to_string()),
        };
        Box::pin(async move {
            let (subject_type, subject_id) = match subject {
                CorrectionSubject::LegalEntity(id) => (SubjectType::LegalEntity, id),
                CorrectionSubject::BusinessRegistration(id) => {
                    (SubjectType::BusinessRegistration, id)
                }
            };
            let write = GovernedWrite {
                rule: RuleCode::EntityIdentifierCorrection,
                subject_type,
                subject_id,
                payload,
                affected_periods: &[],
            };
            consume_exception_conn(conn, exception_id, &write)
                .await
                .map_err(kernel)?;
            let stored = get_exception_conn(conn, exception_id)
                .await
                .map_err(kernel)?;
            Ok(match stored.and_then(|s| s.fallback_kind) {
                Some(FallbackKind::SoleHolder) => CorrectionCover::SoleHolder,
                _ => CorrectionCover::SecondPerson,
            })
        })
    }
}

/// One statement as the owner with the tenant armed; the row must exist.
async fn as_owner(owner: &PgPool, sql: &'static str, id: Uuid) -> Result<(), sqlx::Error> {
    let mut tx = owner.begin().await?;
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(ORG_A.to_string())
        .execute(&mut *tx)
        .await?;
    // rls-arming: ok test fixture writes as owner with the tenant armed
    let done = sqlx::query(sql).bind(id).execute(&mut *tx).await?;
    assert_eq!(done.rows_affected(), 1, "{sql}");
    tx.commit().await
}

fn gate() -> Option<Arc<dyn GovernedCorrectionPort>> {
    Some(Arc::new(Governance))
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn after_go_live_only_a_consumed_exception_for_exactly_this_value_admits_it(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG_A, "A").await;
    let entity = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", CRN))
        .await
        .unwrap()
        .record
        .id;
    let doc = evidence(&store, &actor, "go-live").await;
    set_operating(&owner, ORG_A).await;
    as_owner(
        &owner,
        "UPDATE legal_entities SET identity_locked_at = now() WHERE id = $1",
        entity,
    )
    .await
    .unwrap();

    let refused = |e| code(e).0;
    let no_exception = store
        .correct_entity_identifier(&cmd(&actor), entity, crn_fix(doc, None), gate())
        .await;
    assert_eq!(
        refused(no_exception.unwrap_err()),
        "identifier_correction_needs_exception"
    );

    // The requester records the exception over the canonical payload (sole holder: step-up).
    let request = |value: &str| json!({ "field": "crn", "value": value, "document_id": doc });
    let mut tx = store.pool().begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(ORG_A.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let mut ids = Vec::new();
    for value in [FIXED_CRN, "0001110099991"] {
        let payload = request(value);
        let req = ExceptionRequest {
            rule: RuleCode::EntityIdentifierCorrection,
            subject_type: SubjectType::LegalEntity,
            subject_id: entity,
            reason_code: "REGISTRY_DIFFERS",
            note: None,
            payload: &payload,
            affected_periods: &[],
            requested_by: actor.user,
            step_up_assertion_id: Some(Uuid::new_v4()),
            other_eligible_holders: 0,
        };
        let settings = ExceptionSettings {
            approval_ttl_days: 14,
            sole_holder_mode: SoleHolderMode::StepUpNoticeReview,
            sole_holder_review_due: std::time::Duration::from_secs(30 * 86_400),
        };
        ids.push(
            request_exception_conn(&mut tx, &req, &settings)
                .await
                .unwrap()
                .id,
        );
    }
    tx.commit().await.unwrap();

    let unwired = store
        .correct_entity_identifier(&cmd(&actor), entity, crn_fix(doc, Some(ids[0])), None)
        .await;
    assert_eq!(
        refused(unwired.unwrap_err()),
        "identifier_correction_unavailable"
    );
    // An exception for another value never admits this one.
    assert!(
        store
            .correct_entity_identifier(&cmd(&actor), entity, crn_fix(doc, Some(ids[1])), gate())
            .await
            .is_err()
    );

    let saved = store
        .correct_entity_identifier(&cmd(&actor), entity, crn_fix(doc, Some(ids[0])), gate())
        .await
        .unwrap();
    let console_entity_adapter_postgres::CorrectionOutcome::Applied(saved) = saved else {
        panic!("expected applied correction")
    };
    assert_eq!(
        (saved.change_mode.as_str(), saved.record.crn.unwrap().value),
        ("SOLE_HOLDER", FIXED_CRN.to_owned())
    );
    assert_eq!(ledger(&owner, entity).await[0].3, "SOLE_HOLDER");
    // Single use: the same exception admits nothing more.
    let again = IdentifierCorrectionInput {
        value: Some(CRN.into()),
        ..crn_fix(doc, Some(ids[0]))
    };
    assert!(
        store
            .correct_entity_identifier(&cmd(&actor), entity, again, gate())
            .await
            .is_err()
    );
    // And the DB lock still refuses a change with no governed ledger row.
    let raw = as_owner(
        &owner,
        "UPDATE legal_entities SET crn = '0002110006241' WHERE id = $1",
        entity,
    )
    .await;
    assert!(raw.unwrap_err().to_string().contains("identifier_locked"));
}
