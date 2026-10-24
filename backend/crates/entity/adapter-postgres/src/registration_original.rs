// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{
    PgEntityError, PgEntityStore, admit,
    command::{Outcome, claim, finish},
};
use console_entity_application::{Actor, EntityDocumentView};
use console_entity_domain::{Refusal, document::DocumentKind};
use console_kernel_core::WriteClass;
use console_platform_db::with_audits;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

impl PgEntityStore {
    /// Attach an existing original as evidence without changing any dated fact.
    /// # Errors
    /// Unknown/voided registration, invalid document, idempotency or phase refusal.
    pub async fn attach_registration_original(
        &self,
        actor: &Actor,
        registration: Uuid,
        document: Uuid,
    ) -> Result<EntityDocumentView, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| Box::pin(async move {
            if let Some(done) = claim(tx, &actor, "business_registration.attach_original", json!({"registration":registration,"document":document})).await? {
                return Ok((crate::documents::one(tx, done.target.ok_or_else(|| Refusal::not_found("document_not_found"))?, false).await?, vec![]));
            }
            let row = sqlx::query("SELECT legal_entity_id,voided_at FROM business_registrations WHERE id=$1 FOR UPDATE").bind(registration).fetch_optional(tx.as_mut()).await?.ok_or_else(|| Refusal::not_found("registration_not_found"))?;
            if row.try_get::<Option<time::OffsetDateTime>, _>("voided_at")?.is_some() { return Err(Refusal::conflict("registration_voided", "the registration was voided").into()); }
            admit(tx, WriteClass::EntityStructure).await?;
            let doc = crate::documents::one(tx, document, true).await?;
            if doc.kind != DocumentKind::BizRegCert { return Err(Refusal::field("document_id", "document_not_certificate").into()); }
            let (saved, event) = crate::documents::attach_in_tx(tx, &actor, document, row.try_get("legal_entity_id")?, Some(registration)).await?;
            finish(tx, &actor, &Outcome { target: Some(document), ..Outcome::default() }).await?;
            Ok((saved, event.into_iter().collect()))
        })).await
    }
}
