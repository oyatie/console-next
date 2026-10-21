//! The one INSERT of `person_record_revisions` (0261): common columns plus
//! the typed value columns of the entry's section; the rest stay NULL.

use console_hr_domain::record::{RecordFields, RecordSource, RevisionKind};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use super::store_cols::cols;
use crate::HrError;

/// What one revision row records besides its values.
pub(crate) struct NewRevision<'a> {
    pub entry_id: Uuid,
    pub version: i64,
    pub kind: RevisionKind,
    pub command_id: Uuid,
    pub digest: &'a [u8],
    pub reason: Option<&'a str>,
    pub batch: Option<Uuid>,
    pub actor: Uuid,
    pub fields: &'a RecordFields,
}

pub(crate) async fn insert_revision(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    rev: NewRevision<'_>,
) -> Result<(), HrError> {
    let c = cols(rev.fields);
    let source = if rev.batch.is_some() {
        RecordSource::Import
    } else {
        RecordSource::Manual
    };
    sqlx::query(
        "INSERT INTO person_record_revisions (org_id, entry_id, section, version, kind, command_id, \
         payload_digest, reason, source, import_batch_id, actor_id, \
         edu_school, edu_level, edu_major, edu_status, edu_entered_on, edu_ended_on, \
         qual_name, qual_kind, qual_grade, qual_issuer, qual_number, qual_acquired_on, qual_expires_on, \
         mil_status, mil_branch, mil_rank, mil_served_from, mil_served_to, \
         trn_course, trn_provider, trn_status, trn_started_on, trn_ended_on, trn_hours, \
         lang_language, lang_test, lang_score, lang_taken_on, lang_expires_on, \
         rnd_title, rnd_decided_on, rnd_issuer, rnd_details, rnd_ends_on, \
         fam_relation, fam_name, fam_birth_date, fam_cohabiting, \
         dis_severity, dis_recognised_on, vet_target, vet_recognised_on, \
         basis, basis_consent_on, basis_statute) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, \
         $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, \
         $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48, $49, $50, $51, $52, $53, \
         $54, $55, $56)",
    )
    .bind(org)
    .bind(rev.entry_id)
    .bind(rev.fields.section().as_str())
    .bind(rev.version)
    .bind(rev.kind.as_str())
    .bind(rev.command_id)
    .bind(rev.digest)
    .bind(rev.reason)
    .bind(source.as_str())
    .bind(rev.batch)
    .bind(rev.actor)
    .bind(c.edu_school)
    .bind(c.edu_level)
    .bind(c.edu_major)
    .bind(c.edu_status)
    .bind(c.edu_entered_on)
    .bind(c.edu_ended_on)
    .bind(c.qual_name)
    .bind(c.qual_kind)
    .bind(c.qual_grade)
    .bind(c.qual_issuer)
    .bind(c.qual_number)
    .bind(c.qual_acquired_on)
    .bind(c.qual_expires_on)
    .bind(c.mil_status)
    .bind(c.mil_branch)
    .bind(c.mil_rank)
    .bind(c.mil_served_from)
    .bind(c.mil_served_to)
    .bind(c.trn_course)
    .bind(c.trn_provider)
    .bind(c.trn_status)
    .bind(c.trn_started_on)
    .bind(c.trn_ended_on)
    .bind(c.trn_hours)
    .bind(c.lang_language)
    .bind(c.lang_test)
    .bind(c.lang_score)
    .bind(c.lang_taken_on)
    .bind(c.lang_expires_on)
    .bind(c.rnd_title)
    .bind(c.rnd_decided_on)
    .bind(c.rnd_issuer)
    .bind(c.rnd_details)
    .bind(c.rnd_ends_on)
    .bind(c.fam_relation)
    .bind(c.fam_name)
    .bind(c.fam_birth_date)
    .bind(c.fam_cohabiting)
    .bind(c.dis_severity)
    .bind(c.dis_recognised_on)
    .bind(c.vet_target)
    .bind(c.vet_recognised_on)
    .bind(c.basis)
    .bind(c.basis_consent_on)
    .bind(c.basis_statute)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}
