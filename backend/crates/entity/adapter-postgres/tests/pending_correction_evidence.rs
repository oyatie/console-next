// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! A pending registration-number correction keeps the live certificate intact.

mod common;
mod corrections_support;

use common::*;
use console_entity_adapter_postgres::{
    CorrectionOutcome, CorrectionSubject, GovernedCorrectionFuture, GovernedCorrectionPort,
    OpsCover, OpsCoverFuture, RequestedCorrection,
};
use console_entity_domain::correction::IdentifierCorrectionInput;
use console_entity_domain::document::validate_upload;
use console_kernel_core::KernelError;
use corrections_support::*;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;

struct PendingCorrection(Uuid);

impl GovernedCorrectionPort for PendingCorrection {
    fn cover_as_ops<'tx>(
        &self,
        _tx: &'tx mut sqlx::Transaction<'_, sqlx::Postgres>,
        cover: OpsCover<'tx>,
    ) -> OpsCoverFuture<'tx> {
        assert!(matches!(
            cover.subject,
            CorrectionSubject::BusinessRegistration(_)
        ));
        assert_eq!(cover.payload["value"], "0008100071");
        let id = self.0;
        Box::pin(async move { Ok(RequestedCorrection::Pending(id)) })
    }

    fn consume<'a>(
        &'a self,
        _conn: &'a mut sqlx::PgConnection,
        _exception_id: Uuid,
        _subject: CorrectionSubject,
        _payload: &'a Value,
    ) -> GovernedCorrectionFuture<'a> {
        Box::pin(async { Err(KernelError::internal("pending correction must not consume")) })
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pending_registration_correction_preserves_current_and_proposed_certificates(
    owner: PgPool,
) {
    let org = Uuid::new_v4();
    let (store, actor) = tenant(&owner, org, "pending-registration").await;
    let entity = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", CRN))
        .await
        .unwrap()
        .record
        .id;
    let registration = store
        .create_registration(&cmd(&actor), entity, certificate("000-81-00009"))
        .await
        .unwrap()
        .record
        .id;
    let mut documents = Vec::new();
    for tag in ["current", "proposed"] {
        let document = validate_upload(
            Some("BIZ_REG_CERT"),
            Some("사업자등록증.pdf"),
            format!("%PDF-1.7 {tag}").into_bytes(),
        )
        .unwrap();
        documents.push(store.upload_document(&actor, document).await.unwrap().id);
    }
    let (current, proposed) = (documents[0], documents[1]);
    store
        .attach_document(&cmd(&actor), current, entity, Some(registration))
        .await
        .unwrap();
    set_operating(&owner, org).await;
    let exception = Uuid::new_v4();
    let gate = Some(Arc::new(PendingCorrection(exception)) as Arc<dyn GovernedCorrectionPort>);
    let correction = IdentifierCorrectionInput {
        field: Some("brn".into()),
        value: Some("000-81-00071".into()),
        by_ops: true,
        step_up: Some(json!({})),
        ..crn_fix(proposed, None)
    };
    let missing = store
        .correct_registration_number(
            &cmd(&actor),
            registration,
            IdentifierCorrectionInput {
                document_id: Some(Uuid::new_v4()),
                ..correction.clone()
            },
            gate.clone(),
        )
        .await
        .unwrap_err();
    assert_eq!(
        code(missing).1,
        vec![("document_id".into(), "document_not_found")]
    );
    let outcome = store
        .correct_registration_number(&cmd(&actor), registration, correction, gate)
        .await
        .unwrap();
    assert!(
        matches!(outcome, CorrectionOutcome::Pending { exception_id, .. } if exception_id == exception)
    );

    let current = store.get_document(&actor, current).await.unwrap();
    assert_eq!(
        current.superseded_at, None,
        "waiting must not supersede the live certificate"
    );
    assert_eq!(
        (current.legal_entity_id, current.registration_id),
        (Some(entity), Some(registration))
    );
    let proposed = store.get_document(&actor, proposed).await.unwrap();
    assert_eq!(
        (
            proposed.legal_entity_id,
            proposed.registration_id,
            proposed.superseded_at
        ),
        (None, None, None)
    );
    let number: String = sqlx::query_scalar("SELECT brn FROM business_registrations WHERE id = $1")
        .bind(registration)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(number, "0008100009");
    assert!(ledger(&owner, entity).await.is_empty());
    let proposal: Value = sqlx::query_scalar("SELECT after_snap->'proposal' FROM audit_events WHERE target_id = $1 AND action = 'exception.request'")
        .bind(exception.to_string())
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(
        proposal,
        json!({"field":"brn", "value":"0008100071", "document_id":proposed.id, "reason_code":"REGISTRY_DIFFERS"})
    );
}
