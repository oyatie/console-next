// SPDX-License-Identifier: LicenseRef-Proprietary
//! Mint a payload-bound governed fact in the completion transaction.
use super::{CaseItem, CompleteItem, EvidenceDocument, refused};
use crate::HrError;
use console_governance_adapter_postgres::exception::{AttestRequest, attest_conn};
use console_governance_domain::exception::{
    Attestation, AttestationDetails, Risk, RuleCode, RuleKind, SubjectType,
};
use console_platform_auth::{MobilePasskeyStepUpBinding, MobileStepUpActionKind, PasskeyService};
use console_platform_authz::Principal;
use console_settings_adapter_postgres::validate_reason_in_tx;
use console_settings_domain::code_lists::ReasonDomain;
use serde_json::json;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

fn document_valid(document: &EvidenceDocument) -> bool {
    !document.name.trim().is_empty()
        && document.name.chars().count() <= 200
        && document.url.len() <= 2000
        && document.url.parse::<http::Uri>().is_ok_and(|url| {
            url.scheme_str() == Some("https")
                && url.host().is_some()
                && url
                    .authority()
                    .is_some_and(|authority| !authority.as_str().contains('@'))
        })
}

pub(super) async fn mint(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    item: &CaseItem,
    body: &mut CompleteItem,
    passkeys: Option<&PasskeyService>,
) -> Result<Option<Uuid>, HrError> {
    let Some(given) = body.attestation.as_ref() else {
        return Ok(None);
    };
    if body.observed_ref.is_some()
        || body.exception_id.is_some()
        || body.waive
        || body.reason.is_some()
        || !document_valid(&given.document)
        || given.note.chars().count() > 1000
    {
        return Err(refused("lifecycle.refuse.evidence_required"));
    }
    let rule = item
        .completion_rule_ref
        .as_deref()
        .and_then(|code| RuleCode::parse(code).ok())
        .filter(|rule| rule.kind() == RuleKind::Fact)
        .ok_or_else(|| refused("lifecycle.refuse.evidence_required"))?;
    let date = console_hr_domain::text::parse_yyyy_mm_dd(&given.fact_date)?;
    let today: time::Date = sqlx::query_scalar("SELECT (now() AT TIME ZONE lifecycle_time_zone(c.org_id,c.employee_id,c.effective_date,c.workplace_id))::date FROM lifecycle_cases c WHERE c.org_id=$1 AND c.id=$2")
        .bind(p.org_id.as_uuid()).bind(item.case_id).fetch_one(tx.as_mut()).await?;
    if date > today {
        return Err(refused("lifecycle.refuse.evidence_required"));
    }
    let reason = validate_reason_in_tx(
        tx.as_mut(),
        p.org_id,
        ReasonDomain::Exception,
        &given.reason_code,
        Some(&given.note),
    )
    .await
    .map_err(HrError::from_kernel)?;
    let payload = json!({"case_id":item.case_id,"item_id":item.id,"expected_version":body.expected_version,"attestation":given});
    let binding = MobilePasskeyStepUpBinding::bound(
        MobileStepUpActionKind::ExceptionDecide,
        item.id,
        crate::digest::sha256_hex(
            crate::exits::settlement::canonical_json(&payload)
                .to_string()
                .as_bytes(),
        ),
    );
    let assertion = if rule.risk() != Risk::Low {
        let required = || {
            let mut error = refused("step_up_required");
            error.status = http::StatusCode::UNAUTHORIZED;
            error
        };
        let passkeys = passkeys.ok_or_else(required)?;
        let envelope = body.step_up.take().ok_or_else(required)?;
        Some(
            passkeys
                .verify_and_record_step_up_in_tx(tx, envelope, *p.user_id.as_uuid(), &binding)
                .await
                .map_err(|error| match error {
                    console_platform_auth::MobilePasskeyStepUpVerificationError::Auth(
                        console_platform_auth::AuthError::Sqlx(_)
                        | console_platform_auth::AuthError::Db(_),
                    ) => HrError::internal(error.to_string()),
                    _ => {
                        let mut failed = refused("step_up_failed");
                        failed.status = http::StatusCode::UNAUTHORIZED;
                        failed
                    }
                })?,
        )
    } else {
        None
    };
    let fact = Attestation {
        fact: rule,
        fact_date: date,
        details: AttestationDetails {
            evidence_ref: Some(
                serde_json::to_string(&given.document)
                    .map_err(|error| HrError::internal(error.to_string()))?,
            ),
            ..Default::default()
        },
    };
    let settings = crate::directory::create_exception::exception_settings(tx, p.org_id).await?;
    let recorded = attest_conn(
        tx.as_mut(),
        &AttestRequest {
            attestation: &fact,
            subject_type: SubjectType::LifecycleCaseItem,
            subject_id: item.id,
            reason_code: &reason.code,
            note: reason.note.as_deref(),
            attested_by: p.user_id,
            step_up_assertion_id: assertion,
        },
        &settings,
    )
    .await
    .map_err(super::write::governance)?;
    body.exception_id = Some(recorded.exception_id);
    Ok(Some(recorded.attestation_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn evidence_is_a_named_https_document_without_embedded_credentials() {
        for (name, url, valid) in [
            ("계약서", "https://files.example/contract.pdf", true),
            ("", "https://files.example/contract.pdf", false),
            ("계약서", "javascript:alert(1)", false),
            (
                "계약서",
                "https://user:secret@files.example/contract.pdf",
                false,
            ),
        ] {
            assert_eq!(
                document_valid(&EvidenceDocument {
                    name: name.into(),
                    url: url.into()
                }),
                valid
            );
        }
    }
}
