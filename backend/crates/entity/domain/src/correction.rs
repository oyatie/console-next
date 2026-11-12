//! Identifier corrections (MR-17) and workplace registration-link changes (MR-18):
//! input validation into typed commands. Pure; the adapter checks the facts
//! (current values, the registration chosen, the tenant phase).

use console_kernel_core::kr::{BizRegNo, CorpRegNo, SubWorkplaceSerial};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::code_enum;
use crate::codes::{BizKind, CertificateRevisionReason};
use crate::refusal::{Issues, NOT_APPLICABLE, REQUIRED, Refusal};

code_enum! {
    /// The locked identifiers (business type, corporate registration number on
    /// the legal entity; business registration number on a registration).
    IdentifierField { BizKind => "biz_kind", Crn => "crn", Brn => "brn" }
}

code_enum! {
    /// Why an identifier was wrong (closed list; the evidence is the document).
    CorrectionReason {
        TypoAtEntry => "TYPO_AT_ENTRY",
        RegistryDiffers => "REGISTRY_DIFFERS",
        OtherEvidenced => "OTHER_EVIDENCED",
    }
}

/// What the client sends to correct one identifier.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IdentifierCorrectionInput {
    pub field: Option<String>,
    pub value: Option<String>,
    /// The evidence, uploaded first (`POST /entity-documents`).
    pub document_id: Option<Uuid>,
    pub reason_code: Option<String>,
    /// After go-live: the approved (or sole-holder recorded) governed
    /// exception for exactly this correction.
    pub exception_id: Option<Uuid>,
    /// After go-live, the tenant ops account covering the correction itself
    /// (decisions #26 item d): its passkey step-up envelope, bound to
    /// [`IdentifierCorrection::ops_step_up_line`]. Not part of the command's
    /// fingerprint, so a retry with a fresh step-up replays.
    #[serde(default, skip_serializing)]
    pub step_up: Option<serde_json::Value>,
    /// Set by the REST face from the verified principal, never from the body.
    #[serde(skip)]
    pub by_ops: bool,
}

/// A validated correction: the value is canonical (digits, or the code).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IdentifierCorrection {
    pub field: IdentifierField,
    pub value: String,
    pub document_id: Uuid,
    pub reason: CorrectionReason,
    pub exception_id: Option<Uuid>,
}

impl IdentifierCorrection {
    /// The payload a governed exception for this correction is fingerprinted
    /// over: the requester sends exactly this object (canonical value).
    #[must_use]
    pub fn governed_payload(&self) -> GovernedCorrectionPayload<'_> {
        GovernedCorrectionPayload {
            field: self.field.as_str(),
            value: &self.value,
            document_id: self.document_id,
        }
    }

    /// The line the tenant ops account's step-up is bound to when it covers
    /// this correction itself (decisions #26 item d): the client hashes
    /// exactly this text.
    #[must_use]
    pub fn ops_step_up_line(&self) -> String {
        format!(
            "ENTITY_IDENTIFIER_CORRECTION\n{}\n{}\n{}",
            self.field.as_str(),
            self.value,
            self.document_id
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct GovernedCorrectionPayload<'a> {
    pub field: &'a str,
    pub value: &'a str,
    pub document_id: Uuid,
}

/// Validate a correction aimed at a legal entity (`on_registration = false`:
/// biz_kind or crn) or at a business registration (`true`: brn).
///
/// # Errors
/// Every field issue at once (`validation_failed`).
pub fn validate_correction(
    input: &IdentifierCorrectionInput,
    on_registration: bool,
) -> Result<IdentifierCorrection, Refusal> {
    let mut is = Issues::default();
    let field = is.choice(
        "field",
        input.field.as_deref(),
        true,
        IdentifierField::parse,
    );
    if field.is_some_and(|f| (f == IdentifierField::Brn) != on_registration) {
        is.push("field", NOT_APPLICABLE);
    }
    let raw = input.value.as_deref();
    let value = match field {
        Some(IdentifierField::BizKind) => is
            .choice("value", raw, true, BizKind::parse)
            .map(|k| k.as_str().to_owned()),
        Some(IdentifierField::Crn) => is
            .parsed("value", raw, true, CorpRegNo::parse)
            .map(|c| c.as_str().to_owned()),
        Some(IdentifierField::Brn) => is
            .parsed("value", raw, true, BizRegNo::parse)
            .map(|b| b.as_str().to_owned()),
        None => None,
    };
    if input.document_id.is_none() {
        is.push("document_id", REQUIRED);
    }
    let reason = is.choice(
        "reason_code",
        input.reason_code.as_deref(),
        true,
        CorrectionReason::parse,
    );
    is.finish_opt(|| {
        Some(IdentifierCorrection {
            field: field?,
            value: value?,
            document_id: input.document_id?,
            reason: reason?,
            exception_id: input.exception_id,
        })
    })
}

/// Move a workplace to another business registration and/or sub-workplace
/// serial number, from a date.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RegistrationChangeInput {
    /// The business registration it files VAT under from `effective_from` (`null`: none).
    pub registration_id: Option<Uuid>,
    /// Sub-workplace serial number under a business-unit taxation registration
    /// held by another workplace.
    pub sub_serial: Option<String>,
    pub effective_from: Option<String>,
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RegistrationChange {
    pub registration_id: Option<Uuid>,
    pub sub_serial: Option<SubWorkplaceSerial>,
    pub effective_from: time::Date,
    pub reason_code: crate::PersonReason,
}

/// `unit_of_other`: the target registration is a business-unit taxation one
/// held by another workplace (then the serial is required; otherwise it is refused).
///
/// # Errors
/// Field issues: a future date is `date_in_future` (a dated link
/// applied later needs a worker job, decisions #17; record it on its date).
pub fn validate_registration_change(
    input: &RegistrationChangeInput,
    unit_of_other: bool,
    today: time::Date,
) -> Result<RegistrationChange, Refusal> {
    let mut is = Issues::default();
    let sub_serial = is.parsed(
        "sub_serial",
        input.sub_serial.as_deref(),
        unit_of_other,
        SubWorkplaceSerial::parse,
    );
    if sub_serial.is_some() && !unit_of_other {
        is.push("sub_serial", NOT_APPLICABLE);
    }
    let effective_from = is.date(
        "effective_from",
        input.effective_from.as_deref(),
        true,
        Some(today),
    );
    let reason_code = crate::revision_reason::person_reason(&mut is, input.reason_code.as_deref());
    is.finish_opt(|| {
        Some(RegistrationChange {
            registration_id: input.registration_id,
            sub_serial,
            effective_from: effective_from?,
            reason_code: reason_code?,
        })
    })
}

/// Certificate reissue / correction: the newly issued certificate (kept
/// evidence), why it was issued, and from when the facts it prints hold.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReissueInput {
    pub document_id: Option<Uuid>,
    pub reason: Option<String>,
    pub effective_from: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reissue {
    pub document_id: Uuid,
    pub reason: CertificateRevisionReason,
    pub effective_from: time::Date,
}

/// The new certificate is required, so is its issue date (`cert_issued_on`, the
/// registration input's): neither the change nor the issue lies after today.
///
/// # Errors
/// Field issues (`required`, an unknown reason, `date_in_future`).
pub fn validate_reissue(
    input: &ReissueInput,
    cert_issued_on: Option<&str>,
    today: time::Date,
) -> Result<Reissue, Refusal> {
    let mut is = Issues::default();
    if input.document_id.is_none() {
        is.push("document_id", REQUIRED);
    }
    let reason = is.choice(
        "reason",
        input.reason.as_deref(),
        true,
        CertificateRevisionReason::parse,
    );
    let effective_from = is.date(
        "effective_from",
        input.effective_from.as_deref(),
        true,
        Some(today),
    );
    is.date("cert_issued_on", cert_issued_on, true, Some(today));
    is.finish_opt(|| {
        Some(Reissue {
            document_id: input.document_id?,
            reason: reason?,
            effective_from: effective_from?,
        })
    })
}

#[cfg(test)]
#[path = "correction_tests.rs"]
mod tests;
