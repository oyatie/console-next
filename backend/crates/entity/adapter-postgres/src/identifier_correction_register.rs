// SPDX-License-Identifier: LicenseRef-Proprietary
//! Read the correction proposal and the append-only controller sign-off alongside its governed case.
use console_kernel_core::KernelError;
use console_platform_db::settings_read::db_error;
use serde::Serialize;
use serde_json::Value;
use sqlx::{PgConnection, Row};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub struct CorrectionCase {
    pub id: Uuid,
    pub entity_id: Uuid,
    pub entity_name: String,
    pub subject_id: Uuid,
    pub subject_type: String,
    pub status: String,
    pub requested_by: Uuid,
    pub requester_name: String,
    pub decision_note: Option<String>,
    pub review_note: Option<String>,
    pub payload_hash: String,
    pub proposal: Option<Value>,
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub review_due_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub reviewed_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub consumed_at: Option<OffsetDateTime>,
}

/// A page ordered by the controller's due date, then creation and ID for stable ties.
pub async fn list_conn(
    conn: &mut PgConnection,
    entity: Option<Uuid>,
    id: Option<Uuid>,
    offset: i64,
    limit: i64,
) -> Result<Vec<CorrectionCase>, KernelError> {
    let rows = sqlx::query(
        "SELECT e.*, h.id AS entity_id, r.name AS entity_name, \
          COALESCE(p.after_snap->'proposal', \
            jsonb_build_object('field', c.field, 'value', c.new_value, 'document_id', c.document_id, 'reason_code', c.reason_code)) AS proposal, \
          u.display_name AS requester_name, v.created_at AS reviewed_at, v.after_snap->>'note' AS review_note \
         FROM governed_exceptions e JOIN users u ON u.id=e.requested_by \
         LEFT JOIN business_registrations b ON e.subject_type='BUSINESS_REGISTRATION' AND b.id=e.subject_id \
         JOIN legal_entities h ON h.id=CASE WHEN e.subject_type='LEGAL_ENTITY' THEN e.subject_id ELSE b.legal_entity_id END \
         JOIN LATERAL (SELECT name FROM legal_entity_revisions WHERE legal_entity_id=h.id ORDER BY version DESC LIMIT 1) r ON true \
         LEFT JOIN LATERAL (SELECT after_snap FROM audit_events WHERE target_type='governed_exception' AND target_id=e.id::text AND action='exception.request' ORDER BY created_at,id LIMIT 1) p ON true \
         LEFT JOIN LATERAL (SELECT field,new_value,document_id,reason_code FROM entity_identifier_corrections WHERE exception_id=e.id ORDER BY created_at,field LIMIT 1) c ON true \
         LEFT JOIN LATERAL (SELECT created_at,after_snap FROM audit_events WHERE target_type='governed_exception' AND target_id=e.id::text AND action='exception.review' ORDER BY created_at,id LIMIT 1) v ON true \
         WHERE e.rule_code='ENTITY_IDENTIFIER_CORRECTION' AND ($1::uuid IS NULL OR h.id=$1) AND ($4::uuid IS NULL OR e.id=$4) \
         ORDER BY e.review_due_at NULLS LAST, e.created_at DESC, e.id DESC LIMIT $2 OFFSET $3",
    ).bind(entity).bind(limit).bind(offset).bind(id).fetch_all(conn).await.map_err(db_error)?;
    rows.into_iter()
        .map(|row| {
            let proposal: Value = row.try_get("proposal").map_err(db_error)?;
            Ok(CorrectionCase {
                id: row.try_get("id").map_err(db_error)?,
                entity_id: row.try_get("entity_id").map_err(db_error)?,
                entity_name: row.try_get("entity_name").map_err(db_error)?,
                subject_id: row.try_get("subject_id").map_err(db_error)?,
                subject_type: row.try_get("subject_type").map_err(db_error)?,
                status: row.try_get("status").map_err(db_error)?,
                requested_by: row.try_get("requested_by").map_err(db_error)?,
                requester_name: row.try_get("requester_name").map_err(db_error)?,
                decision_note: row.try_get("decision_note").map_err(db_error)?,
                review_note: row.try_get("review_note").map_err(db_error)?,
                payload_hash: row.try_get("fingerprint").map_err(db_error)?,
                proposal: proposal
                    .get("value")
                    .filter(|value| !value.is_null())
                    .map(|_| proposal.clone()),
                expires_at: row.try_get("expires_at").map_err(db_error)?,
                created_at: row.try_get("created_at").map_err(db_error)?,
                review_due_at: row.try_get("review_due_at").map_err(db_error)?,
                reviewed_at: row.try_get("reviewed_at").map_err(db_error)?,
                consumed_at: row.try_get("consumed_at").map_err(db_error)?,
            })
        })
        .collect()
}

/// The subject's head is already locked by the correction command, serializing admissions.
pub async fn has_open_conn(conn: &mut PgConnection, subject: Uuid) -> Result<bool, KernelError> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM governed_exceptions WHERE rule_code='ENTITY_IDENTIFIER_CORRECTION' AND subject_id=$1 AND status IN ('PENDING','APPROVED') AND consumed_at IS NULL AND expires_at > now())")
        .bind(subject).fetch_one(conn).await.map_err(db_error)
}

pub async fn lock_review_conn(conn: &mut PgConnection, id: Uuid) -> Result<bool, KernelError> {
    sqlx::query("SELECT id FROM governed_exceptions WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db_error)?;
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM audit_events WHERE target_type='governed_exception' AND target_id=$1::text AND action='exception.review')")
        .bind(id).fetch_one(conn).await.map_err(db_error)
}
