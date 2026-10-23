// SPDX-License-Identifier: LicenseRef-Proprietary
//! Open correction work, including contributor facts, in one set-based read.
use console_kernel_core::KernelError;
use console_platform_db::settings_read::db_error;
use sqlx::{PgConnection, Row};
use time::OffsetDateTime;
use uuid::Uuid;

pub struct InboxCase {
    pub id: Uuid,
    pub status: String,
    pub requested_by: Uuid,
    pub entity_name: String,
    pub requester_name: String,
    pub created_at: OffsetDateTime,
    pub review_due_at: Option<OffsetDateTime>,
    pub expires_at: OffsetDateTime,
    pub excluded: Vec<Uuid>,
}

pub async fn open_conn(
    conn: &mut PgConnection,
    as_of: OffsetDateTime,
) -> Result<Vec<InboxCase>, KernelError> {
    let rows = sqlx::query(
        "SELECT e.id,e.status,e.requested_by,e.created_at,e.expires_at,e.review_due_at, r.name AS entity_name,u.display_name AS requester_name, \
         ARRAY(SELECT actor FROM ( \
           SELECT created_by AS actor FROM legal_entities WHERE e.subject_type='LEGAL_ENTITY' AND id=e.subject_id \
           UNION SELECT actor_id FROM legal_entity_revisions WHERE e.subject_type='LEGAL_ENTITY' AND legal_entity_id=e.subject_id \
           UNION SELECT created_by FROM business_registrations WHERE e.subject_type='BUSINESS_REGISTRATION' AND id=e.subject_id \
           UNION SELECT actor_id FROM business_registration_revisions WHERE e.subject_type='BUSINESS_REGISTRATION' AND registration_id=e.subject_id \
           UNION SELECT actor_id FROM entity_identifier_corrections WHERE \
             (e.subject_type='LEGAL_ENTITY' AND legal_entity_id=e.subject_id AND registration_id IS NULL) OR \
             (e.subject_type='BUSINESS_REGISTRATION' AND registration_id=e.subject_id)) contributors WHERE actor IS NOT NULL) AS excluded \
         FROM governed_exceptions e JOIN users u ON u.id=e.requested_by \
         LEFT JOIN business_registrations b ON e.subject_type='BUSINESS_REGISTRATION' AND b.id=e.subject_id \
         JOIN legal_entities h ON h.id=CASE WHEN e.subject_type='LEGAL_ENTITY' THEN e.subject_id ELSE b.legal_entity_id END \
         JOIN LATERAL (SELECT name FROM legal_entity_revisions WHERE legal_entity_id=h.id ORDER BY version DESC LIMIT 1) r ON true \
         WHERE e.rule_code='ENTITY_IDENTIFIER_CORRECTION' AND e.created_at<=$1 AND ( \
           (e.status IN ('PENDING','APPROVED') AND e.expires_at>now() AND e.consumed_at IS NULL) OR \
           (e.status='RECORDED' AND NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.target_type='governed_exception' AND a.target_id=e.id::text AND a.action='exception.review'))) \
         ORDER BY e.created_at,e.id")
        .bind(as_of).fetch_all(conn).await.map_err(db_error)?;
    rows.into_iter()
        .map(|r| {
            Ok(InboxCase {
                id: r.try_get("id").map_err(db_error)?,
                status: r.try_get("status").map_err(db_error)?,
                requested_by: r.try_get("requested_by").map_err(db_error)?,
                entity_name: r.try_get("entity_name").map_err(db_error)?,
                requester_name: r.try_get("requester_name").map_err(db_error)?,
                created_at: r.try_get("created_at").map_err(db_error)?,
                expires_at: r.try_get("expires_at").map_err(db_error)?,
                review_due_at: r.try_get("review_due_at").map_err(db_error)?,
                excluded: r.try_get("excluded").map_err(db_error)?,
            })
        })
        .collect()
}
