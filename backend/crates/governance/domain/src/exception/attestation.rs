//! Attestation of an offline fact (decisions.md #3): a form with date and
//! evidence, never a bare tick. It is a BW-06 record whose rule is a
//! [`RuleKind::Fact`]; the attestation row carries what the law measures.

use console_kernel_core::{Date, KernelError};
use serde::{Deserialize, Serialize};

use super::rule::{RuleCode, RuleKind};

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct AttestationDetails {
    /// Attachment or document reference.
    pub evidence_ref: Option<String>,
    /// Delivery or return method code (catalogued by BW-07).
    pub method_code: Option<String>,
    /// Statutory exception code (근퇴법 §9② IRP).
    pub detail_code: Option<String>,
    /// Agreed new due date (§36 단서 / 근퇴법 §9① 단서).
    pub new_due_date: Option<Date>,
    /// Paid amount in KRW.
    pub amount_krw: Option<i64>,
    /// Payment or filing reference.
    pub reference: Option<String>,
    /// 접수번호 per insurer.
    pub receipt_numbers: Vec<String>,
    /// Filer identity (e.g. the agent's office) when no number or receipt exists.
    pub filer: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attestation {
    pub fact: RuleCode,
    /// The date the fact happened (receipt, delivery, agreement, request, filing, payment).
    pub fact_date: Date,
    pub details: AttestationDetails,
}

/// Outcome of a valid attestation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttestationCheck {
    /// 상실신고 완료 attested without a 접수번호.
    pub review_flag: bool,
}

fn present(value: Option<&String>) -> bool {
    value.is_some_and(|v| !v.trim().is_empty())
}

fn need(ok: bool, field: &str) -> Result<(), KernelError> {
    if ok {
        Ok(())
    } else {
        Err(KernelError::validation(format!(
            "attestation_{field}_required"
        )))
    }
}

/// Check the fields the fact's row in the decisions.md #3 table requires.
pub fn validate_attestation(a: &Attestation) -> Result<AttestationCheck, KernelError> {
    if a.fact.kind() != RuleKind::Fact {
        return Err(KernelError::validation("attestation_rule_not_fact"));
    }
    let d = &a.details;
    let evidence = present(d.evidence_ref.as_ref());
    let method = present(d.method_code.as_ref());
    let numbers = d.receipt_numbers.iter().any(|n| !n.trim().is_empty());
    match a.fact {
        RuleCode::ResignationReceived | RuleCode::ResignationWithdrawn => {
            need(evidence, "evidence")?
        }
        RuleCode::DismissalNoticeDelivered => {
            need(method, "method")?;
            need(evidence, "evidence")?;
        }
        RuleCode::PaymentDueExtensionAgreed => {
            need(d.new_due_date.is_some(), "new_due_date")?;
            need(evidence, "evidence")?;
        }
        RuleCode::IrpTransferException => need(present(d.detail_code.as_ref()), "detail_code")?,
        RuleCode::InsuranceLossReported => {
            need(
                numbers || evidence || present(d.filer.as_ref()),
                "filing_evidence",
            )?;
        }
        RuleCode::FinalPayCompleted => {
            need(d.amount_krw.is_some_and(|v| v >= 0), "amount")?;
            need(present(d.reference.as_ref()), "reference")?;
        }
        RuleCode::LifecycleItemAttested => need(evidence, "evidence")?,
        RuleCode::SettlementItemAttested => need(method, "method")?,
        // Request date only: `fact_date` is the request date.
        _ => {}
    }
    Ok(AttestationCheck {
        review_flag: a.fact == RuleCode::InsuranceLossReported && !numbers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn att(fact: RuleCode, details: AttestationDetails) -> Attestation {
        Attestation {
            fact,
            fact_date: console_kernel_core::Timestamp::UNIX_EPOCH.date(),
            details,
        }
    }

    fn err(a: &Attestation) -> String {
        validate_attestation(a).unwrap_err().message
    }

    #[test]
    fn soft_rule_code_is_not_an_attestation() {
        let a = att(RuleCode::OrgChangeBackdated, AttestationDetails::default());
        assert_eq!(err(&a), "attestation_rule_not_fact");
    }

    #[test]
    fn every_fact_rejects_an_empty_form_unless_its_date_is_the_whole_fact() {
        let date_only = [
            RuleCode::EarlyLossReportRequested,
            RuleCode::SeparationCertificateRequested,
            RuleCode::EmploymentCertificateRequested,
        ];
        for &fact in RuleCode::ALL.iter().filter(|r| r.kind() == RuleKind::Fact) {
            let result = validate_attestation(&att(fact, AttestationDetails::default()));
            assert_eq!(result.is_ok(), date_only.contains(&fact), "{fact:?}");
        }
    }

    #[test]
    fn blank_strings_do_not_count_as_evidence() {
        let details = AttestationDetails {
            method_code: Some("REGISTERED_MAIL".into()),
            evidence_ref: Some("  ".into()),
            ..AttestationDetails::default()
        };
        let a = att(RuleCode::DismissalNoticeDelivered, details);
        assert_eq!(err(&a), "attestation_evidence_required");
    }

    #[test]
    fn final_pay_needs_amount_and_reference() {
        let mut details = AttestationDetails {
            amount_krw: Some(3_000_000),
            ..AttestationDetails::default()
        };
        assert_eq!(
            err(&att(RuleCode::FinalPayCompleted, details.clone())),
            "attestation_reference_required"
        );
        details.reference = Some("BANK-123".into());
        assert!(validate_attestation(&att(RuleCode::FinalPayCompleted, details)).is_ok());
    }

    #[test]
    fn loss_report_takes_any_one_evidence_form_and_flags_a_missing_number() {
        let by_filer = AttestationDetails {
            filer: Some("노무법인 대행".into()),
            ..AttestationDetails::default()
        };
        let check = validate_attestation(&att(RuleCode::InsuranceLossReported, by_filer)).unwrap();
        assert!(check.review_flag);
        let by_number = AttestationDetails {
            receipt_numbers: vec!["EI-2026-0001".into()],
            ..AttestationDetails::default()
        };
        let check = validate_attestation(&att(RuleCode::InsuranceLossReported, by_number)).unwrap();
        assert!(!check.review_flag);
    }
}
