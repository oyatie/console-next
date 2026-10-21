//! 사업자등록 typed revision rows (+ business types, co-owners), and the
//! revise step every registration revision goes through.

use console_entity_application::{Actor, RegistrationRevision, RegistrationStatusInput};
use console_entity_domain::Refusal;
use console_entity_domain::codes::OperatingStatus;
use console_entity_domain::document::DocumentKind;
use console_entity_domain::registration::{
    EntityContext, RegistrationDraft, resolve_vat_unit_mode, validate_registration,
};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::address::insert_address;
use crate::legal_entity_revision::set_vat_unit;
use crate::registration::{declared_vat, open_registrations};
use crate::workplace::lock_entity;
use crate::{PgEntityError, RevisionMeta, Tx, audit, today_kst};

pub(crate) async fn insert_revision(
    tx: &mut Tx<'_>,
    id: Uuid,
    d: &RegistrationDraft,
    status: (OperatingStatus, Option<time::Date>, Option<time::Date>),
    m: &RevisionMeta<'_>,
    evidence: Option<Uuid>,
) -> Result<(), PgEntityError> {
    let address = insert_address(tx, &d.business_address).await?;
    let reason = d.issue_reason.as_ref();
    let rev: Uuid = sqlx::query_scalar(
        "INSERT INTO business_registration_revisions (org_id, registration_id, version, effective_from, trade_name, \
           opened_on, business_address_id, production_factor, issue_reason_kind, issue_reason_sub, \
           issue_reason_as_printed, liquor_license_no, unit_taxation, e_invoice_email, cert_issued_on, tax_office_code, \
           tax_office_label, tax_type, status, status_since, status_until, change_mode, reason_code, actor_id, payload_digest, \
           settings_snapshot, command_id, classification_reason, evidence_document_id) \
         VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, \
           $14,$15,$16,$17,$18,$19,$20,$21,$22,$23, sha256(convert_to($24::jsonb::text, 'UTF8')), $25, $26, CASE WHEN $27 THEN $28 ELSE (SELECT classification_reason FROM business_registration_revisions WHERE registration_id = $1 ORDER BY effective_from DESC, version DESC LIMIT 1) END, $29) RETURNING id",
    )
    .bind(id)
    .bind(m.version)
    .bind(m.effective_from)
    .bind(&d.trade_name)
    .bind(d.opened_on)
    .bind(address)
    .bind(&d.production_factor)
    .bind(reason.map(|r| r.0.as_str()))
    .bind(reason.and_then(|r| r.1).map(|s| s.as_str()))
    .bind(reason.and_then(|r| r.2.clone()))
    .bind(&d.liquor_license_no)
    .bind(d.unit_taxation)
    .bind(d.e_invoice_email.as_ref().map(|e| e.as_str().to_owned()))
    .bind(d.cert_issued_on)
    .bind(&d.tax_office_code)
    .bind(&d.tax_office_label)
    .bind(d.tax_type.as_str())
    .bind(status.0.as_str())
    .bind(status.1)
    .bind(status.2)
    .bind(m.admitted.mode.as_str())
    .bind(m.reason_code.as_str())
    .bind(*m.actor.user.as_uuid())
    .bind(&m.payload)
    .bind(m.admitted.snapshot())
    .bind(crate::command::command_id(m.actor)?)
    .bind(d.classification_reason.is_some())
    .bind(d.classification_reason.as_ref().and_then(|v| v.as_deref()))
    .bind(evidence)
    .fetch_one(tx.as_mut())
    .await?;
    for (seq, t) in d.business_types.iter().enumerate() {
        sqlx::query(
            "INSERT INTO business_registration_business_types (org_id, revision_id, seq, is_main, sector_as_printed, \
               item_as_printed, nts_code, ksic_code, ksic_label, ksic_version) \
             VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1,$2,$3,$4,$5,$6,$7,$8,$9)",
        )
        .bind(rev)
        .bind(i16::try_from(seq + 1).unwrap_or(i16::MAX))
        .bind(t.is_main)
        .bind(&t.sector_as_printed)
        .bind(&t.item_as_printed)
        .bind(&t.nts_code)
        .bind(t.ksic.as_ref().map(|k| k.code.clone()))
        .bind(t.ksic.as_ref().map(|k| k.label.clone()))
        .bind(t.ksic.as_ref().map(|k| k.version.clone()))
        .execute(tx.as_mut())
        .await?;
    }
    for (seq, name) in d.co_owners.iter().enumerate() {
        sqlx::query(
            "INSERT INTO business_registration_co_owners (org_id, revision_id, seq, name) \
             VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, $2, $3)",
        )
        .bind(rev)
        .bind(i16::try_from(seq + 1).unwrap_or(i16::MAX))
        .bind(name)
        .execute(tx.as_mut())
        .await?;
    }
    Ok(())
}

/// The certificate a registration revision of `registration` is recorded
/// from: a kept 사업자등록증, not another record's, and new — never the one in
/// force nor one already superseded (the same file dropped again is the same
/// document). Checked before the revision names it (its FK would fault).
pub(crate) async fn new_certificate(
    tx: &mut Tx<'_>,
    doc: Uuid,
    entity: Uuid,
    registration: Uuid,
) -> Result<(), PgEntityError> {
    let doc = match crate::documents::one(tx, doc, true).await {
        Err(PgEntityError::Refused(r)) if r.code == "document_not_found" => {
            return Err(Refusal::field("document_id", "document_not_found").into());
        }
        other => other?,
    };
    let code = if doc.kind != DocumentKind::BizRegCert {
        "document_not_certificate"
    } else if doc.attached_elsewhere(entity, Some(registration)) {
        "document_attached_elsewhere"
    } else if doc.superseded_at.is_some() || doc.registration_id == Some(registration) {
        "document_not_new"
    } else {
        return Ok(());
    };
    Err(Refusal::field("document_id", code).into())
}

/// Append a full-state revision of registration `id` inside the caller's
/// transaction (linked to `evidence` when given). Returns the 법인.
pub(crate) async fn revise_registration_in_tx(
    tx: &mut Tx<'_>,
    actor: &Actor,
    admitted: crate::Admitted,
    id: Uuid,
    rev: &RegistrationRevision,
    status: RegistrationStatusInput,
    evidence: Option<Uuid>,
) -> Result<
    (
        Uuid,
        Vec<console_entity_domain::Warning>,
        Vec<console_kernel_core::AuditEvent>,
    ),
    PgEntityError,
> {
    let env = crate::revision_envelope(rev)?;
    let (effective_from, reason) = (env.effective_from, env.reason);
    let head = sqlx::query(
        "SELECT legal_entity_id, brn, voided_at IS NOT NULL AS voided, \
           (SELECT COALESCE(max(version), 0) FROM business_registration_revisions r WHERE r.registration_id = h.id) AS version \
         FROM business_registrations h WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| Refusal::not_found("registration_not_found"))?;
    if head.try_get::<bool, _>("voided")? {
        return Err(Refusal::conflict("registration_voided", "the registration was voided").into());
    }
    crate::revision_copy::ensure_registration_version(tx, id, env.expected_version).await?;
    let entity: Uuid = head.try_get("legal_entity_id")?;
    let facts = lock_entity(tx, entity).await?;
    // After the 법인's lock, as on create: one lock order for the document.
    if let Some(doc) = evidence {
        new_certificate(tx, doc, entity, id).await?;
    }
    let today = today_kst(tx).await?;
    let ctx = EntityContext {
        biz_kind: facts.biz_kind,
        entity_name: &facts.name,
    };
    let (draft, warnings) = validate_registration(&rev.input, ctx, today)?;
    crate::name_evidence::revise_classification(tx, entity, id, facts.biz_kind, &draft).await?;
    let mut is = console_entity_domain::Issues::default();
    let RegistrationStatusInput {
        status,
        status_since,
        status_until,
    } = status;
    let status = is.choice("status", status.as_deref(), true, OperatingStatus::parse);
    let since = is.date(
        "status_since",
        status_since.as_deref(),
        status.is_some_and(|s| s != OperatingStatus::Continuing),
        Some(today),
    );
    let until = console_entity_domain::suspension::status_until(
        &mut is,
        status_until.as_deref(),
        status,
        since,
    );
    let (status, since) = is.finish_opt(|| Some((status?, since)))?;
    let old_brn: Option<String> = head.try_get("brn")?;
    let new_brn = draft.brn.as_ref().map(|b| b.as_str().to_owned());
    if old_brn.is_some() && old_brn != new_brn {
        return Err(Refusal::field("brn", "use_identifier_correction")
            .with_remedy("request_identifier_correction")
            .into());
    }
    let closed_on = (status == OperatingStatus::Closed)
        .then_some(since)
        .flatten();
    if closed_on.is_some() {
        crate::closure::ensure_registration_closable(tx, id).await?;
    }
    sqlx::query(
        "UPDATE business_registrations SET brn = $2, brn_pending_reason = $3, needs_confirmation = false, \
           closed_on = $4 WHERE id = $1",
    )
    .bind(id)
    .bind(&new_brn)
    .bind(draft.brn_pending_reason.map(|r| r.as_str()))
    .bind(closed_on)
    .execute(tx.as_mut())
    .await?;
    let version: i32 = head.try_get::<i32, _>("version")? + 1;
    let meta = RevisionMeta {
        version,
        effective_from,
        reason_code: reason.clone().into(),
        admitted,
        actor,
        payload: serde_json::to_value(&draft)?,
    };
    insert_revision(tx, id, &draft, (status, since, until), &meta, evidence).await?;
    let open_after = open_registrations(tx, entity, None).await?;
    if open_after > 0 {
        let (mode, basis) = resolve_vat_unit_mode(
            declared_vat(tx, entity).await?,
            open_after,
            draft.unit_taxation,
        )?;
        // Never dated before today: a back-dated append would sort under
        // the entity's later revisions and the new VAT unit be lost.
        let vat_meta = RevisionMeta {
            effective_from: effective_from.max(today),
            ..meta
        };
        set_vat_unit(tx, entity, mode, basis.as_str(), &vat_meta).await?;
    }
    let event = audit(
        actor,
        "business_registration.revise",
        "business_registration",
        id,
        admitted,
        json!({
            "version": version, "effective_from": effective_from.to_string(), "reason_code": reason, "status": status.as_str(),
            "document_id": evidence,
        }),
    )?;
    let event = crate::history::seal_changed_fields(
        tx,
        event,
        crate::history::Record::Registration,
        version,
    )
    .await?;
    Ok((entity, warnings, vec![event]))
}
