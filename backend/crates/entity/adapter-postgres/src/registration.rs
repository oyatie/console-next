//! 사업자등록 writes: create (one certificate), revise, void.

use console_entity_application::{
    Actor, RegistrationRevision, RegistrationStatusInput, RegistrationView, Saved, VoidRecord,
};
use console_entity_domain::Refusal;
use console_entity_domain::codes::{OperatingStatus, UnverifiedReason, VatUnitMode};
use console_entity_domain::registration::{
    EntityContext, RegistrationInput, resolve_vat_unit_mode, validate_registration,
};
use console_kernel_core::WriteClass;
use console_platform_db::with_audits;
use serde_json::json;
use uuid::Uuid;

use crate::command::{Outcome, claim, finish};
use crate::legal_entity::void_reason;
use crate::legal_entity_revision::set_vat_unit;
use crate::registration_revision::{insert_revision, revise_registration_in_tx};
use crate::workplace::lock_entity;
use crate::{PgEntityError, PgEntityStore, RevisionMeta, Tx, admit, audit, read, today_kst};

/// The entity's declared VAT unit, when one was declared (derived ones are recomputed).
pub(crate) async fn declared_vat(
    tx: &mut Tx<'_>,
    entity: Uuid,
) -> Result<Option<VatUnitMode>, PgEntityError> {
    let raw: Option<String> = sqlx::query_scalar(
        "SELECT vat_unit_mode FROM legal_entity_revisions WHERE legal_entity_id = $1 AND vat_unit_mode_basis = 'DECLARED' \
         ORDER BY effective_from DESC, version DESC LIMIT 1",
    )
    .bind(entity)
    .fetch_optional(tx.as_mut())
    .await?
    .flatten();
    Ok(raw.as_deref().and_then(VatUnitMode::parse))
}

pub(crate) async fn open_registrations(
    tx: &mut Tx<'_>,
    entity: Uuid,
    except: Option<Uuid>,
) -> Result<usize, PgEntityError> {
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM business_registrations WHERE legal_entity_id = $1 AND voided_at IS NULL \
           AND closed_on IS NULL AND ($2::uuid IS NULL OR id <> $2)",
    )
    .bind(entity)
    .bind(except)
    .fetch_one(tx.as_mut())
    .await?;
    Ok(usize::try_from(n).unwrap_or(0))
}

impl PgEntityStore {
    /// Record one 사업자등록증's facts. The entity's VAT unit is derived from
    /// the facts while they decide it, and asked for once they no longer do.
    ///
    /// # Errors
    /// Field issues, duplicate 사업자등록번호, `vat_unit_mode` required, or
    /// database faults.
    pub async fn create_registration(
        &self,
        actor: &Actor,
        entity: Uuid,
        input: RegistrationInput,
    ) -> Result<Saved<RegistrationView>, PgEntityError> {
        self.create_registration_evidenced(actor, entity, input, None)
            .await
    }

    /// [`Self::create_registration`] with the certificate it is typed from:
    /// attached in the same transaction and named as the first revision's
    /// evidence, so the history shows every issued certificate.
    ///
    /// # Errors
    /// As [`Self::create_registration`], plus the document's refusals.
    pub async fn create_registration_evidenced(
        &self,
        actor: &Actor,
        entity: Uuid,
        input: RegistrationInput,
        evidence: Option<Uuid>,
    ) -> Result<Saved<RegistrationView>, PgEntityError> {
        self.create_registration_checked(actor, entity, input, evidence, None)
            .await
    }

    /// Create with the explicitly accepted preview result, atomically with its evidence.
    /// # Errors
    /// As create, including changed preview values or missing acknowledgment.
    pub async fn create_registration_checked(
        &self,
        actor: &Actor,
        entity: Uuid,
        input: RegistrationInput,
        evidence: Option<Uuid>,
        preview: Option<console_entity_application::registration_check::PreviewAcceptance>,
    ) -> Result<Saved<RegistrationView>, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                // The key only when given: a retry without one hashes as the N-1 binary's did.
                let mut request = json!({ "entity": entity, "input": input });
                if let Some(doc) = evidence { request["document_id"] = json!(doc); }
                if let Some(p) = &preview { request["check_preview"] = json!(p); }
                if let Some(done) = claim(tx, &actor, "business_registration.create", request).await? {
                    return Ok((replay(tx, entity, done).await?, vec![]));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                let facts = lock_entity(tx, entity).await?;
                let today = today_kst(tx).await?;
                let ctx = EntityContext { biz_kind: facts.biz_kind, entity_name: &facts.name, head_trade_name: None };
                let (draft, warnings) = validate_registration(&input, ctx, today)?;
                // The unique index is the backstop; checking first names the
                // number before any later rule (VAT unit) can mask it.
                if let Some(brn) = &draft.brn {
                    let taken: bool = sqlx::query_scalar(
                        "SELECT EXISTS (SELECT 1 FROM business_registrations \
                           WHERE brn = $1 AND voided_at IS NULL AND closed_on IS NULL)",
                    )
                    .bind(brn.as_str())
                    .fetch_one(tx.as_mut())
                    .await?;
                    if taken {
                        return Err(Refusal::field("brn", "brn_already_registered").into());
                    }
                }
                let open_after = open_registrations(tx, entity, None).await? + 1;
                crate::name_evidence::classification(facts.biz_kind, draft.brn.as_ref().map(|b| b.as_str()), open_after == 1, draft.classification_reason.as_ref().and_then(|r| r.as_deref()))?;
                let (mode, basis) = resolve_vat_unit_mode(declared_vat(tx, entity).await?, open_after, draft.unit_taxation)?;
                let id: Uuid = sqlx::query_scalar(
                    "INSERT INTO business_registrations (org_id, legal_entity_id, brn, brn_pending_reason, unverified_reason, \
                       created_change_mode, created_by) \
                     VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, $2, $3, $4, $5, $6) RETURNING id",
                )
                .bind(entity)
                .bind(draft.brn.as_ref().map(|b| b.as_str().to_owned()))
                .bind(draft.brn_pending_reason.map(|r| r.as_str()))
                .bind(if draft.brn.is_some() { UnverifiedReason::NotChecked } else { UnverifiedReason::NewRegistrationPending }.as_str())
                .bind(admitted.mode.as_str())
                .bind(*actor.user.as_uuid())
                .fetch_one(tx.as_mut())
                .await?;
                // INTEG-3: the first record starts at 개업일 when it is known.
                let effective_from = draft.opened_on;
                let meta = RevisionMeta { version: 1, effective_from, reason_code: console_entity_domain::SystemReason::Create.into(), admitted, actor: &actor, payload: serde_json::to_value(&draft)? };
                if let Some(doc) = evidence {
                    crate::registration_revision::new_certificate(tx, doc, entity, id).await?;
                }
                let checked=crate::registration_check_preview::accepted_preview(tx,&actor,entity,preview.as_ref(),draft.brn.as_ref().map(|n|n.as_str()),draft.opened_on).await?;
                let status=checked.as_ref().and_then(|a|a.reported_status).unwrap_or(OperatingStatus::Continuing);
                let since=crate::registration_check_preview::initial_status_since(checked.as_ref(),preview.as_ref(),today)?;
                insert_revision(tx, id, &draft, (status, since, None), &meta, evidence).await?;
                if status == OperatingStatus::Closed {
                    sqlx::query("UPDATE business_registrations SET closed_on=$2 WHERE id=$1").bind(id).bind(since).execute(tx.as_mut()).await?;
                }
                if let Some(answer)=checked {
                    let checked_at: Option<time::OffsetDateTime>=sqlx::query_scalar("SELECT (outcome->>'checked_at')::timestamptz FROM entity_commands WHERE command_id=$1").bind(preview.as_ref().map(|p|p.command_id)).fetch_one(tx.as_mut()).await?;
                    crate::registration_check::append(tx,id,Some(*actor.user.as_uuid()),&answer,checked_at).await?;
                }
                // After the revision: the certificate takes its 발급일 from it.
                let attached = match evidence {
                    Some(doc) => crate::documents::attach_in_tx(tx, &actor, doc, entity, Some(id)).await?.1,
                    None => None,
                };
                // The VAT unit is a fact learned today: dated at 개업일 it would
                // sort under the entity's later revisions and be lost.
                set_vat_unit(tx, entity, mode, basis.as_str(), &RevisionMeta { effective_from: today, ..meta }).await?;
                let event = audit(&actor, "business_registration.create", "business_registration", id, admitted, json!({
                    "legal_entity_id": entity, "brn": draft.brn.as_ref().map(|b| b.as_str()),
                    "vat_unit_mode": mode.as_str(), "vat_unit_mode_basis": basis.as_str(),
                }))?;
                finish(tx, &actor, &Outcome { target: Some(id), change_mode: Some(admitted.mode.as_str().into()), count: None }).await?;
                let record = one(tx, entity, id).await?;
                Ok((Saved { record, warnings, change_mode: admitted.mode.as_str().into() }, std::iter::once(event).chain(attached).collect()))
            })
        })
        .await
    }

    /// A new revision of a registration (full state; status changes such as
    /// 휴업/폐업 are confirmed here, effective-dated). With `evidence`, the
    /// new original is attached in the same transaction, supersedes the one
    /// kept before and is linked to the revision.
    ///
    /// # Errors
    /// Field issues, `identifier_locked`, the document's refusals, or database faults.
    pub async fn revise_registration(
        &self,
        actor: &Actor,
        id: Uuid,
        rev: RegistrationRevision,
        status: RegistrationStatusInput,
    ) -> Result<Saved<RegistrationView>, PgEntityError> {
        self.revise_registration_evidenced(actor, id, rev, status, None)
            .await
    }

    /// [`Self::revise_registration`] with the new original as its evidence.
    ///
    /// # Errors
    /// As [`Self::revise_registration`], plus the document's refusals.
    pub async fn revise_registration_evidenced(
        &self,
        actor: &Actor,
        id: Uuid,
        rev: RegistrationRevision,
        status: RegistrationStatusInput,
        evidence: Option<Uuid>,
    ) -> Result<Saved<RegistrationView>, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                // The key only when given: a retry without one hashes as the N-1 binary's did.
                let mut request = json!({ "id": id, "revision": rev, "status": status.status, "status_since": status.status_since, "status_until": status.status_until });
                if let Some(doc) = evidence { request["document_id"] = json!(doc); }

                if let Some(done) = claim(tx, &actor, "business_registration.revise", request).await? {
                    let entity = registration_entity(tx, id).await?;
                    return Ok((replay(tx, entity, done).await?, vec![]));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                let (entity, warnings, mut events) = revise_registration_in_tx(tx, &actor, admitted, id, &rev, status, evidence).await?;
                if let Some(doc) = evidence {
                    events.extend(crate::documents::attach_in_tx(tx, &actor, doc, entity, Some(id)).await?.1);
                }
                finish(tx, &actor, &Outcome { target: Some(id), change_mode: Some(admitted.mode.as_str().into()), count: None }).await?;
                let record = one(tx, entity, id).await?;
                Ok((Saved { record, warnings, change_mode: admitted.mode.as_str().into() }, events))
            })
        })
        .await
    }

    /// Undo a mistaken registration during setup.
    ///
    /// # Errors
    /// `phase_not_setup`, `record_in_use` (a 사업장 files under it), or database faults.
    pub async fn void_registration(
        &self,
        actor: &Actor,
        id: Uuid,
        cmd: VoidRecord,
    ) -> Result<(), PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                if claim(tx, &actor, "business_registration.void", json!({ "id": id, "void": cmd })).await?.is_some() {
                    return Ok(((), vec![]));
                }
                let admitted = admit(tx, WriteClass::SetupVoid).await?;
                let reason = void_reason(cmd.reason_code.as_deref())?;
                let entity = registration_entity(tx, id).await?;
                // Workplace creation takes this parent lock before checking its registration.
                sqlx::query("SELECT id FROM legal_entities WHERE id = $1 FOR UPDATE")
                    .bind(entity)
                    .fetch_one(tx.as_mut())
                    .await?;
                let used: i64 = sqlx::query_scalar("SELECT count(*) FROM workplaces WHERE registration_id = $1 AND voided_at IS NULL")
                    .bind(id)
                    .fetch_one(tx.as_mut())
                    .await?;
                if used > 0 {
                    return Err(Refusal::conflict("record_in_use", format!("{used} workplaces file under this registration"))
                        .with_remedy("move_workplaces_first")
                        .into());
                }
                let changed = sqlx::query("UPDATE business_registrations SET voided_at = now(), void_reason_code = $2 WHERE id = $1 AND voided_at IS NULL")
                    .bind(id)
                    .bind(&reason)
                    .execute(tx.as_mut())
                    .await?
                    .rows_affected();
                if changed != 1 {
                    return Err(Refusal::not_found("registration_not_found").into());
                }
                let event = audit(&actor, "business_registration.void", "business_registration", id, admitted, json!({ "reason_code": reason }))?;
                finish(tx, &actor, &Outcome::default()).await?;
                Ok(((), vec![event]))
            })
        })
        .await
    }
}

pub(crate) async fn registration_entity(tx: &mut Tx<'_>, id: Uuid) -> Result<Uuid, PgEntityError> {
    sqlx::query_scalar("SELECT legal_entity_id FROM business_registrations WHERE id = $1")
        .bind(id)
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(|| Refusal::not_found("registration_not_found").into())
}

/// A replayed registration command: the record as it is now.
pub(crate) async fn replay(
    tx: &mut Tx<'_>,
    entity: Uuid,
    done: Outcome,
) -> Result<Saved<RegistrationView>, PgEntityError> {
    let id = done
        .target
        .ok_or_else(|| Refusal::not_found("registration_not_found"))?;
    Ok(Saved {
        record: one(tx, entity, id).await?,
        warnings: Vec::new(),
        change_mode: done.change_mode.unwrap_or_default(),
    })
}

pub(crate) async fn one(
    tx: &mut Tx<'_>,
    entity: Uuid,
    id: Uuid,
) -> Result<RegistrationView, PgEntityError> {
    read::entities(tx, Some(entity), None, true)
        .await?
        .into_iter()
        .flat_map(|e| e.registrations)
        .find(|r| r.id == id)
        .ok_or_else(|| Refusal::not_found("registration_not_found").into())
}
