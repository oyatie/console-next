//! Adapter error: a domain refusal, or a database fault. Known constraint
//! violations become refusals naming the field (never a raw 500).

use console_entity_domain::Refusal;
use console_kernel_core::KernelError;
use console_platform_db::DbError;

#[derive(Debug, thiserror::Error)]
pub enum PgEntityError {
    #[error("refused: {}", .0.code)]
    Refused(Refusal),
    #[error(transparent)]
    Db(DbError),
}

impl From<Refusal> for PgEntityError {
    fn from(value: Refusal) -> Self {
        Self::Refused(value)
    }
}

impl From<KernelError> for PgEntityError {
    fn from(value: KernelError) -> Self {
        Self::Refused(Refusal::from(value))
    }
}

impl From<DbError> for PgEntityError {
    fn from(value: DbError) -> Self {
        match value {
            DbError::Sqlx(err) => Self::from(err),
            other => Self::Db(other),
        }
    }
}

impl From<sqlx::Error> for PgEntityError {
    fn from(err: sqlx::Error) -> Self {
        if let Some(refusal) = constraint_refusal(&err) {
            return Self::Refused(refusal);
        }
        Self::Db(DbError::Sqlx(err))
    }
}

impl From<serde_json::Error> for PgEntityError {
    fn from(value: serde_json::Error) -> Self {
        Self::Db(DbError::Serialize(value))
    }
}

fn constraint_refusal(err: &sqlx::Error) -> Option<Refusal> {
    let db = err.as_database_error()?;
    let message = db.message();
    let by_constraint = match db.constraint() {
        Some("legal_entities_crn_open_uniq") => {
            Some(Refusal::field("crn", "crn_already_registered"))
        }
        Some("business_registrations_brn_open_uniq") => {
            Some(Refusal::field("brn", "brn_already_registered"))
        }
        Some("workplaces_sub_serial_uniq") => {
            Some(Refusal::field("sub_serial", "sub_serial_taken"))
        }
        Some("workplace_kinds_label_uniq") => Some(Refusal::field("label", "label_taken")),
        // Backstop: the revise step checks the certificate before naming it.
        Some("business_registration_revisions_evidence_fk") => {
            Some(Refusal::field("document_id", "document_not_found"))
        }
        Some("workplaces_branch_uniq") => Some(Refusal::field("name", "workplace_branch_taken")),
        Some("branches_region_id_name_key") => Some(Refusal::field("name", "workplace_name_taken")),
        Some("org_unit_placements_represents_uniq") => {
            Some(Refusal::conflict("workplace_already_has_unit", message))
        }
        _ => None,
    };
    by_constraint.or_else(|| {
        if message.contains("(workplace_closed)") {
            Some(Refusal::field("workplace_id", "workplace_closed"))
        } else if message.contains("(legal_entity_closed)") {
            Some(Refusal::conflict(
                "legal_entity_not_open",
                "the legal entity is closed",
            ))
        } else if message.contains("assignment_overlap") {
            Some(Refusal::conflict(
                "assignment_overlap",
                "the assignment overlaps another period",
            ))
        } else if message.contains("identifier_locked") {
            Some(
                Refusal::conflict("identifier_locked", "the identifier is locked")
                    .with_remedy("request_identifier_correction"),
            )
        } else {
            None
        }
    })
}
