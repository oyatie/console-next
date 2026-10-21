//! SQL for `person_record_entries` / `person_record_revisions` (0261). Only
//! INSERT and SELECT: the tables are append-only.

use console_hr_domain::record::{RecordFields, RecordSource, RevisionKind, Section};
use sqlx::postgres::PgRow;
use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use super::store_fields::{code, fields_of};
use crate::HrError;

/// One stored revision.
#[derive(Debug, Clone)]
pub(crate) struct Revision {
    pub actor_kind: Option<String>,
    pub command_id: Option<Uuid>,
    pub entry_id: Uuid,
    pub version: i64,
    pub kind: RevisionKind,
    pub source: RecordSource,
    pub reason: Option<String>,
    pub actor_id: Uuid,
    pub created_at: OffsetDateTime,
    pub fields: RecordFields,
}

/// An entry with its latest revision.
#[derive(Debug, Clone)]
pub(crate) struct Current {
    pub person_id: Uuid,
    pub section: Section,
    pub created_at: OffsetDateTime,
    pub head: Revision,
}

impl Current {
    pub fn voided(&self) -> bool {
        self.head.kind == RevisionKind::Void
    }
}

/// The revision columns every read selects (a literal, so the SQL stays static).
macro_rules! cols {
    () => {
        "r.entry_id, r.section, r.version, r.kind, r.source, r.reason, r.actor_id, \
    r.created_at, \
    (SELECT a.actor_kind FROM audit_events a WHERE a.org_id=r.org_id AND a.actor=r.actor_id AND a.created_at=r.created_at AND a.outcome='ALLOWED' ORDER BY a.id DESC LIMIT 1) AS actor_kind, \
    (SELECT a.command_id FROM audit_events a WHERE a.org_id=r.org_id AND a.actor=r.actor_id AND a.created_at=r.created_at AND a.outcome='ALLOWED' ORDER BY a.id DESC LIMIT 1) AS command_id, edu_school, edu_level, edu_major, edu_status, edu_entered_on, edu_ended_on, \
    qual_name, qual_kind, qual_grade, qual_issuer, qual_number, qual_acquired_on, qual_expires_on, \
    mil_status, mil_branch, mil_rank, mil_served_from, mil_served_to, \
    trn_course, trn_provider, trn_status, trn_started_on, trn_ended_on, trn_hours, \
    lang_language, lang_test, lang_score, lang_taken_on, lang_expires_on, \
    rnd_title, rnd_decided_on, rnd_issuer, rnd_details, rnd_ends_on, \
    fam_relation, fam_name, fam_birth_date, fam_cohabiting, \
    dis_severity, dis_recognised_on, vet_target, vet_recognised_on, \
    basis, basis_consent_on, basis_statute"
    };
}

fn revision_of(row: &PgRow) -> Result<(Section, Revision), HrError> {
    let section = code(row, "section", Section::parse)?;
    Ok((
        section,
        Revision {
            actor_kind: row.try_get("actor_kind")?,
            command_id: row.try_get("command_id")?,
            entry_id: row.try_get("entry_id")?,
            version: row.try_get("version")?,
            kind: code(row, "kind", RevisionKind::parse)?,
            source: code(row, "source", RecordSource::parse)?,
            reason: row.try_get("reason")?,
            actor_id: row.try_get("actor_id")?,
            created_at: row.try_get("created_at")?,
            fields: fields_of(section, row)?,
        },
    ))
}

/// The current state of every entry of `persons` (optionally one section),
/// voided ones included; ordered by section, then creation.
pub(crate) async fn load_current(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    persons: &[Uuid],
    section: Option<Section>,
) -> Result<Vec<Current>, HrError> {
    let sql = concat!(
        "SELECT * FROM (SELECT DISTINCT ON (r.entry_id) e.person_id, e.created_at AS entry_created_at, ",
        cols!(),
        " FROM person_record_entries e JOIN person_record_revisions r ON r.org_id = e.org_id AND r.entry_id = e.id \
         WHERE e.org_id = $1 AND e.person_id = ANY($2) AND ($3::text IS NULL OR e.section = $3) \
         ORDER BY r.entry_id, r.version DESC) heads ORDER BY section, entry_created_at, entry_id"
    );
    let rows = sqlx::query(sql)
        .bind(org)
        .bind(persons)
        .bind(section.map(Section::as_str))
        .fetch_all(tx.as_mut())
        .await?;
    rows.iter().map(current_of).collect()
}

fn current_of(row: &PgRow) -> Result<Current, HrError> {
    let (section, head) = revision_of(row)?;
    Ok(Current {
        person_id: row.try_get("person_id")?,
        section,
        created_at: row.try_get("entry_created_at")?,
        head,
    })
}

/// One entry's current state, if visible in this tenant.
pub(crate) async fn load_entry(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    entry: Uuid,
) -> Result<Option<Current>, HrError> {
    let sql = concat!(
        "SELECT e.person_id, e.created_at AS entry_created_at, ",
        cols!(),
        " FROM person_record_entries e JOIN person_record_revisions r ON r.org_id = e.org_id AND r.entry_id = e.id \
         WHERE e.org_id = $1 AND e.id = $2 ORDER BY r.version DESC LIMIT 1"
    );
    let row = sqlx::query(sql)
        .bind(org)
        .bind(entry)
        .fetch_optional(tx.as_mut())
        .await?;
    row.as_ref().map(current_of).transpose()
}

/// Every revision of one entry, oldest first.
pub(crate) async fn load_revisions(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    entry: Uuid,
) -> Result<Vec<Revision>, HrError> {
    let sql = concat!(
        "SELECT ",
        cols!(),
        " FROM person_record_revisions r WHERE r.org_id = $1 AND r.entry_id = $2 ORDER BY r.version"
    );
    let rows = sqlx::query(sql)
        .bind(org)
        .bind(entry)
        .fetch_all(tx.as_mut())
        .await?;
    rows.iter()
        .map(|row| revision_of(row).map(|(_, rev)| rev))
        .collect()
}

/// The entry and payload digest an accepted command wrote, for replay.
pub(crate) async fn find_command(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    command: Uuid,
) -> Result<Option<(Uuid, Vec<u8>)>, HrError> {
    let row = sqlx::query(
        "SELECT entry_id, payload_digest FROM person_record_revisions WHERE org_id = $1 AND command_id = $2",
    )
    .bind(org)
    .bind(command)
    .fetch_optional(tx.as_mut())
    .await?;
    Ok(match row {
        Some(row) => Some((row.try_get("entry_id")?, row.try_get("payload_digest")?)),
        None => None,
    })
}

pub(crate) async fn insert_entry(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    person: Uuid,
    section: Section,
    actor: Uuid,
) -> Result<Uuid, HrError> {
    Ok(sqlx::query_scalar(
        "INSERT INTO person_record_entries (org_id, person_id, section, created_by) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(org)
    .bind(person)
    .bind(section.as_str())
    .bind(actor)
    .fetch_one(tx.as_mut())
    .await?)
}
