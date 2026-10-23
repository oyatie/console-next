//! BW-19 1: a person already on file (any status, EXITED included) is named
//! instead of silently duplicated.
//!
//! Identity (decisions #6): never a legal ID and never a name alone. A
//! candidate is the same name (spaces ignored) with the same phone or the same
//! 생년월일. A registration that names every candidate with a reason goes
//! through as the governed exception `DUPLICATE_NAME_CONFIRMED` (low risk).

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Postgres;
use uuid::Uuid;

use crate::HrError;
use crate::directory::types::NormalizedCreateEmployeeRequest;

/// The governed override of a `duplicate_candidate` refusal: the caller names
/// every candidate it saw and says why this is a different person (rule
/// `DUPLICATE_NAME_CONFIRMED`, low risk; reason domain `exception`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DuplicateOverride {
    pub candidate_ids: Vec<Uuid>,
    pub reason_code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// One person a registration may duplicate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DuplicateCandidate {
    pub employee_id: Uuid,
    pub status: String,
    pub employee_number: Option<String>,
    /// `name_phone` or `name_birth_date`: what matched besides the name.
    pub basis: &'static str,
    /// `rehire` for an EXITED person: register them again as the same person
    /// (`POST /api/v1/employees/{id}/rehire`), not as a new one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remedy: Option<&'static str>,
}

/// Every person with the same name (spaces ignored) and the same phone or the
/// same birth date, EXITED included; merged-away rows are not people.
pub async fn duplicate_candidates(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    request: &NormalizedCreateEmployeeRequest,
) -> Result<Vec<DuplicateCandidate>, HrError> {
    let rows: Vec<(Uuid, String, Option<String>, bool)> = sqlx::query_as(
        "SELECT e.id, e.employment_status, e.employee_number, \
                COALESCE((CASE WHEN console_employee_facts(e.org_id,e.id) ? 'phone' THEN console_employee_facts(e.org_id,e.id)->>'phone' ELSE p.phone_e164 END) = $3, false) AS phone_match \
         FROM person_employees_current e \
         LEFT JOIN employee_employment_profiles p \
           ON p.org_id = e.org_id AND p.employee_id = e.id \
         WHERE e.org_id = $1 AND e.merged_into_employee_id IS NULL \
           AND regexp_replace(COALESCE(console_employee_facts(e.org_id,e.id)->>'legal_name',e.name), '\\s', '', 'g') = regexp_replace($2, '\\s', '', 'g') \
           AND ((CASE WHEN console_employee_facts(e.org_id,e.id) ? 'phone' THEN console_employee_facts(e.org_id,e.id)->>'phone' ELSE p.phone_e164 END) = $3 OR ($4::DATE IS NOT NULL AND (CASE WHEN console_employee_facts(e.org_id,e.id) ? 'birth_date' THEN (console_employee_facts(e.org_id,e.id)->>'birth_date')::DATE ELSE e.birth_date END) = $4::DATE)) \
         ORDER BY e.created_at, e.id",
    )
    .bind(org_uuid)
    .bind(&request.name)
    .bind(&request.phone_e164)
    .bind(request.facts.birth_date.as_deref())
    .fetch_all(tx.as_mut())
    .await?;
    Ok(rows
        .into_iter()
        .map(|(employee_id, status, employee_number, phone_match)| {
            let remedy = (status == "EXITED").then_some("rehire");
            DuplicateCandidate {
                employee_id,
                status,
                employee_number,
                basis: if phone_match {
                    "name_phone"
                } else {
                    "name_birth_date"
                },
                remedy,
            }
        })
        .collect())
}

/// Refuses with 409 `duplicate_candidate` unless an override names every
/// candidate. Returns the override the registration was admitted under.
///
/// # Errors
/// 409 `duplicate_candidate` listing the candidates; 422 for an override that
/// names no reason or a person who is not a candidate.
pub fn admit_duplicates<'a>(
    candidates: &[DuplicateCandidate],
    duplicate_override: Option<&'a DuplicateOverride>,
) -> Result<Option<&'a DuplicateOverride>, HrError> {
    if let Some(given) = duplicate_override {
        if given.reason_code.trim().is_empty() || given.reason_code.len() > 64 {
            return Err(HrError::validation(
                "duplicate_override.reason_code is required",
            ));
        }
        if given
            .candidate_ids
            .iter()
            .any(|id| !candidates.iter().any(|c| c.employee_id == *id))
        {
            return Err(HrError::validation(
                "duplicate_override.candidate_ids names someone who is not a candidate",
            ));
        }
    }
    if candidates.is_empty() {
        return Ok(None);
    }
    let covered = duplicate_override.is_some_and(|given| {
        candidates
            .iter()
            .all(|c| given.candidate_ids.contains(&c.employee_id))
    });
    if !covered {
        return Err(HrError {
            errors: None,
            status: http::StatusCode::CONFLICT,
            code: "duplicate_candidate",
            message: format!(
                "{} people on file may be this person; register again as one of them, or confirm a different person",
                candidates.len()
            ),
            refusals: Some(Box::new(json!(candidates))),
        });
    }
    Ok(duplicate_override)
}

/// The exception payload: ids and codes only (no name, phone or note text).
pub fn override_payload(employee_id: Uuid, given: &DuplicateOverride) -> Value {
    let mut candidate_ids = given.candidate_ids.clone();
    candidate_ids.sort();
    json!({
        "employee_id": employee_id,
        "candidate_ids": candidate_ids,
        "reason_code": given.reason_code.trim(),
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn candidate(status: &str) -> DuplicateCandidate {
        DuplicateCandidate {
            employee_id: Uuid::new_v4(),
            status: status.to_owned(),
            employee_number: None,
            basis: "name_phone",
            remedy: (status == "EXITED").then_some("rehire"),
        }
    }

    fn cover(ids: Vec<Uuid>) -> DuplicateOverride {
        DuplicateOverride {
            candidate_ids: ids,
            reason_code: "OTHER".to_owned(),
            note: Some("동명이인".to_owned()),
        }
    }

    #[test]
    fn no_candidate_admits_without_an_override() {
        assert_eq!(admit_duplicates(&[], None).unwrap(), None);
    }

    #[test]
    fn a_candidate_refuses_until_every_one_is_named() {
        let both = [candidate("ACTIVE"), candidate("EXITED")];
        let refused = admit_duplicates(&both, None).unwrap_err();
        assert_eq!(
            (refused.status.as_u16(), refused.code),
            (409, "duplicate_candidate")
        );
        let listed = refused.refusals.unwrap();
        assert_eq!(listed[1]["remedy"], "rehire");
        assert!(listed[0].get("remedy").is_none());
        let partial = cover(vec![both[0].employee_id]);
        assert_eq!(
            admit_duplicates(&both, Some(&partial)).unwrap_err().code,
            "duplicate_candidate"
        );
        let full = cover(vec![both[0].employee_id, both[1].employee_id]);
        assert_eq!(admit_duplicates(&both, Some(&full)).unwrap(), Some(&full));
    }

    #[test]
    fn an_override_needs_a_reason_and_real_candidates() {
        let one = [candidate("ACTIVE")];
        let mut blank = cover(vec![one[0].employee_id]);
        blank.reason_code = " ".to_owned();
        assert_eq!(
            admit_duplicates(&one, Some(&blank)).unwrap_err().code,
            "validation"
        );
        let stranger = cover(vec![Uuid::new_v4()]);
        assert_eq!(
            admit_duplicates(&one, Some(&stranger)).unwrap_err().code,
            "validation"
        );
        assert_eq!(
            admit_duplicates(&[], Some(&stranger)).unwrap_err().code,
            "validation"
        );
    }

    #[test]
    fn the_payload_carries_no_free_text() {
        let id = Uuid::new_v4();
        let payload = override_payload(id, &cover(vec![id]));
        assert!(payload.get("note").is_none());
        assert_eq!(payload["reason_code"], "OTHER");
    }
}
