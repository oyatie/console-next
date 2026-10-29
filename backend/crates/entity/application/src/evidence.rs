//! Wire shapes for kept documents, dated history and the derived
//! 상시근로자수 placeholder (ENT-CAPTURE).

use console_entity_domain::document::{DocumentKind, retain_until};
use serde::Serialize;
use uuid::Uuid;

/// A kept original. There is no extraction service (lane corrections #10):
/// `extraction_status` is always `NONE` and `extracted` always `null`; the
/// form is typed beside the document.
#[derive(Debug, Clone, Serialize)]
pub struct EntityDocumentView {
    pub id: Uuid,
    pub kind: DocumentKind,
    pub file_name: String,
    pub content_type: String,
    pub byte_size: i32,
    #[serde(with = "time::serde::rfc3339")]
    pub uploaded_at: time::OffsetDateTime,
    pub legal_entity_id: Option<Uuid>,
    pub registration_id: Option<Uuid>,
    #[serde(with = "crate::iso_date::option")]
    pub issued_on: Option<time::Date>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub superseded_at: Option<time::OffsetDateTime>,
    /// The settings key whose period runs from `superseded_at`.
    pub retention_key: String,
    /// `null` while the document is in use (not superseded).
    #[serde(with = "crate::iso_date::option")]
    pub retain_until: Option<time::Date>,
    pub extraction_status: &'static str,
    pub extracted: Option<()>,
    /// Never served: the original holds personal data; the client previews
    /// its own file and the kept one is read through the content route.
    pub preview_url: Option<String>,
}

impl EntityDocumentView {
    /// Fill `retain_until` from the resolved retention period in years.
    #[must_use]
    pub fn with_retention(mut self, years: Option<i64>) -> Self {
        self.retain_until = match (self.superseded_at, years) {
            (Some(at), Some(years)) => {
                let kst = time::UtcOffset::from_hms(9, 0, 0).unwrap_or(time::UtcOffset::UTC);
                retain_until(at.to_offset(kst).date(), years)
            }
            _ => None,
        };
        self
    }

    /// Kept as the evidence of another 법인 or another 사업자등록 than
    /// `entity` / `registration` (one kept on the 법인 alone may move onto
    /// its registration).
    #[must_use]
    pub fn attached_elsewhere(&self, entity: Uuid, registration: Option<Uuid>) -> bool {
        self.legal_entity_id.is_some_and(|e| e != entity)
            || (self.registration_id.is_some() && self.registration_id != registration)
    }
}

/// One field that changed in a revision (values as display text).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FieldChange {
    pub field: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

/// One dated revision of a record, newest first in a history.
#[derive(Debug, Clone, Serialize)]
pub struct RevisionEntry {
    /// Internal immutable subject keys for the fields actually displayed in this delta.
    #[serde(skip)]
    pub subject_refs: Vec<String>,
    pub version: i32,
    #[serde(with = "crate::iso_date")]
    pub effective_from: time::Date,
    #[serde(with = "time::serde::rfc3339")]
    pub recorded_at: time::OffsetDateTime,
    pub actor_name: Option<String>,
    pub actor_kind: Option<String>,
    pub command_id: Option<Uuid>,
    pub change_mode: String,
    pub reason_code: Option<String>,
    pub changes: Vec<FieldChange>,
    /// The kept certificate a registration revision was recorded from
    /// (등록증 재발급·정정); `null` otherwise.
    pub evidence_document_id: Option<Uuid>,
}

/// 상시근로자 수 (근로기준법 시행령 §7의2) of a 법인 or 사업장. Derived, never
/// typed, and HOLD until a 노무사 signs the method off (BW-35): the threshold
/// and look-back rows are not in the statutory register and no 가동일
/// calendar exists, so no number is shown (never a guessed one).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RegularWorkers {
    /// `HOLD` until the method is released.
    pub status: &'static str,
    pub value: Option<u32>,
    /// The instrument the derivation follows, as a code for the catalogs.
    pub basis: &'static str,
    /// What the derivation still needs, as codes for the catalogs.
    pub missing: &'static [&'static str],
    /// People assigned today (the live roster count), shown beside it.
    pub live_headcount: i64,
}

impl RegularWorkers {
    #[must_use]
    pub const fn hold(live_headcount: i64) -> Self {
        Self {
            status: "HOLD",
            value: None,
            basis: "LSA_DECREE_7_2",
            missing: &[
                "labor_attorney_review",
                "statutory_rule_rows",
                "operating_day_calendar",
            ],
            live_headcount,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use time::macros::{date, datetime};

    #[test]
    fn retention_counts_from_the_kst_day_of_supersession() {
        let view = EntityDocumentView {
            id: Uuid::nil(),
            kind: DocumentKind::BizRegCert,
            file_name: "c.pdf".into(),
            content_type: "application/pdf".into(),
            byte_size: 1,
            uploaded_at: datetime!(2026-10-01 0:00 UTC),
            legal_entity_id: None,
            registration_id: None,
            issued_on: None,
            superseded_at: None,
            retention_key: "retention.entity_registration_document".into(),
            retain_until: None,
            extraction_status: "NONE",
            extracted: None,
            preview_url: None,
        };
        assert_eq!(
            view.clone().with_retention(Some(5)).retain_until,
            None,
            "in use"
        );
        let superseded = EntityDocumentView {
            superseded_at: Some(datetime!(2026-10-04 16:00 UTC)),
            ..view
        };
        // 16:00 UTC is already 10-05 in Korea.
        assert_eq!(
            superseded.clone().with_retention(Some(5)).retain_until,
            Some(date!(2031 - 10 - 05))
        );
        assert_eq!(superseded.with_retention(None).retain_until, None);
        let hold = serde_json::to_value(RegularWorkers::hold(7)).unwrap();
        assert_eq!(hold["status"], "HOLD");
        assert!(hold["value"].is_null());
        assert_eq!(hold["live_headcount"], 7);
    }
}
