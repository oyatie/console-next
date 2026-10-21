//! 법인 typed revision rows: the full-state insert and the VAT-unit-only append.

use console_entity_domain::codes::VatUnitMode;
use console_entity_domain::legal_entity::LegalEntityDraft;
use serde_json::json;
use uuid::Uuid;

use crate::address::insert_optional;
use crate::command::command_id;
use crate::{PgEntityError, RevisionMeta, Tx};

pub(crate) async fn insert_revision(
    tx: &mut Tx<'_>,
    id: Uuid,
    d: &LegalEntityDraft,
    vat: Option<(VatUnitMode, &'static str)>,
    m: &RevisionMeta<'_>,
) -> Result<Uuid, PgEntityError> {
    let address = insert_optional(tx, d.head_office_address.as_ref()).await?;
    let rev: Uuid = sqlx::query_scalar(
        "INSERT INTO legal_entity_revisions (org_id, legal_entity_id, version, effective_from, name, display_name, \
           representation_mode, additional_representatives, head_office_address_id, incorporated_on, \
           fiscal_year_end_month, capital_won, vat_unit_mode, vat_unit_mode_basis, main_ksic_code, main_ksic_label, \
           main_ksic_version, main_phone, priority_support, priority_support_basis, large_group_member, change_mode, \
           reason_code, actor_id, payload_digest, settings_snapshot, command_id, english_name) \
         VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, \
           $14,$15,$16,$17,$18,$19,$20,$21,$22,$23, sha256(convert_to($24::jsonb::text, 'UTF8')), $25, $26, CASE WHEN $27 THEN $28 ELSE (SELECT english_name FROM legal_entity_revisions WHERE legal_entity_id = $1 ORDER BY effective_from DESC, version DESC LIMIT 1) END) RETURNING id",
    )
    .bind(id)
    .bind(m.version)
    .bind(m.effective_from)
    .bind(&d.name)
    .bind(&d.display_name)
    .bind(d.representation_mode.as_str())
    .bind(d.additional_representatives)
    .bind(address)
    .bind(d.incorporated_on)
    .bind(d.fiscal_year_end_month)
    .bind(d.capital_won)
    .bind(vat.map(|v| v.0.as_str()))
    .bind(vat.map(|v| v.1))
    .bind(d.main_ksic.as_ref().map(|k| k.code.clone()))
    .bind(d.main_ksic.as_ref().map(|k| k.label.clone()))
    .bind(d.main_ksic.as_ref().map(|k| k.version.clone()))
    .bind(d.main_phone.as_ref().map(|p| p.as_str().to_owned()))
    .bind(d.priority_support.map(|p| p.0.as_str()))
    .bind(d.priority_support.map(|p| p.1.as_str()))
    .bind(d.large_group_member)
    .bind(m.admitted.mode.as_str())
    .bind(m.reason_code.as_str())
    .bind(*m.actor.user.as_uuid())
    .bind(&m.payload)
    .bind(m.admitted.snapshot())
    .bind(command_id(m.actor)?)
    .bind(d.english_name.is_some())
    .bind(d.english_name.as_ref().and_then(|v| v.as_deref()))
    .fetch_one(tx.as_mut())
    .await?;
    for (seq, name) in d.representatives.iter().enumerate() {
        sqlx::query(
            "INSERT INTO legal_entity_representatives (org_id, revision_id, seq, name) \
             VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, $2, $3)",
        )
        .bind(rev)
        .bind(i16::try_from(seq + 1).unwrap_or(i16::MAX))
        .bind(name)
        .execute(tx.as_mut())
        .await?;
    }
    let Some(directors) = &d.directors else {
        carry_directors(tx, id, rev).await?;
        return Ok(rev);
    };
    for (seq, director) in directors.iter().enumerate() {
        sqlx::query(
            "INSERT INTO legal_entity_directors (org_id, revision_id, seq, role, name, appointed_on) \
             VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, $2, $3, $4, $5)",
        )
        .bind(rev)
        .bind(i16::try_from(seq + 1).unwrap_or(i16::MAX))
        .bind(director.role.as_str())
        .bind(&director.name)
        .bind(director.appointed_on)
        .execute(tx.as_mut())
        .await?;
    }
    Ok(rev)
}

/// A revise that omits `directors` keeps the ones of the latest other
/// revision (MR-5: a form that never shows 임원 must not erase them).
async fn carry_directors(tx: &mut Tx<'_>, entity: Uuid, rev: Uuid) -> Result<(), PgEntityError> {
    sqlx::query(
        "INSERT INTO legal_entity_directors (org_id, revision_id, seq, role, name, appointed_on) \
         SELECT d.org_id, $2, d.seq, d.role, d.name, d.appointed_on FROM legal_entity_directors d \
         WHERE d.revision_id = (SELECT r.id FROM legal_entity_revisions r WHERE r.legal_entity_id = $1 AND r.id <> $2 \
                                ORDER BY r.effective_from DESC, r.version DESC LIMIT 1)",
    )
    .bind(entity)
    .bind(rev)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

/// Append a revision that only changes the VAT unit (after a registration is
/// added or closed), copying everything else from the latest revision.
pub(crate) async fn set_vat_unit(
    tx: &mut Tx<'_>,
    id: Uuid,
    mode: VatUnitMode,
    basis: &'static str,
    m: &RevisionMeta<'_>,
) -> Result<(), PgEntityError> {
    let unchanged: bool = sqlx::query_scalar(
        "SELECT COALESCE((SELECT vat_unit_mode = $2 AND vat_unit_mode_basis = $3 FROM legal_entity_revisions \
           WHERE legal_entity_id = $1 ORDER BY effective_from DESC, version DESC LIMIT 1), false)",
    )
    .bind(id)
    .bind(mode.as_str())
    .bind(basis)
    .fetch_one(tx.as_mut())
    .await?;
    if unchanged {
        return Ok(());
    }
    let prev: Uuid = sqlx::query_scalar(
        "SELECT id FROM legal_entity_revisions WHERE legal_entity_id = $1 ORDER BY effective_from DESC, version DESC LIMIT 1",
    )
    .bind(id)
    .fetch_one(tx.as_mut())
    .await?;
    let rev: Uuid = sqlx::query_scalar(
        "INSERT INTO legal_entity_revisions (org_id, legal_entity_id, version, effective_from, name, display_name, \
           representation_mode, additional_representatives, head_office_address_id, incorporated_on, \
           fiscal_year_end_month, capital_won, vat_unit_mode, vat_unit_mode_basis, main_ksic_code, main_ksic_label, \
           main_ksic_version, main_phone, priority_support, priority_support_basis, large_group_member, change_mode, \
           reason_code, actor_id, payload_digest, settings_snapshot, command_id, english_name) \
         SELECT org_id, legal_entity_id, (SELECT max(version) + 1 FROM legal_entity_revisions WHERE legal_entity_id = $1), \
           $2, name, display_name, representation_mode, additional_representatives, head_office_address_id, \
           incorporated_on, fiscal_year_end_month, capital_won, $3, $4, main_ksic_code, main_ksic_label, \
           main_ksic_version, main_phone, priority_support, priority_support_basis, large_group_member, $5, $6, $7, \
           sha256(convert_to($8::jsonb::text, 'UTF8')), $9, $11, english_name \
         FROM legal_entity_revisions WHERE id = $10 RETURNING id",
    )
    .bind(id)
    .bind(m.effective_from)
    .bind(mode.as_str())
    .bind(basis)
    .bind(m.admitted.mode.as_str())
    .bind(console_entity_domain::SystemReason::VatUnitDerived.as_str())
    .bind(*m.actor.user.as_uuid())
    .bind(json!({ "vat_unit_mode": mode.as_str(), "basis": basis }))
    .bind(m.admitted.snapshot())
    .bind(prev)
    .bind(command_id(m.actor)?)
    .fetch_one(tx.as_mut())
    .await?;
    // The named representatives and directors are child rows of a revision: carry them over too.
    for sql in [
        "INSERT INTO legal_entity_representatives (org_id, revision_id, seq, name) \
         SELECT org_id, $2, seq, name FROM legal_entity_representatives WHERE revision_id = $1",
        "INSERT INTO legal_entity_directors (org_id, revision_id, seq, role, name, appointed_on) \
         SELECT org_id, $2, seq, role, name, appointed_on FROM legal_entity_directors WHERE revision_id = $1",
    ] {
        sqlx::query(sql)
            .bind(prev)
            .bind(rev)
            .execute(tx.as_mut())
            .await?;
    }
    Ok(())
}
