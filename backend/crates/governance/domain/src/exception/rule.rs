//! BW-06 rule registry: every soft rule a governed exception (예외 처리) may
//! override, and every offline fact an attestation records
//! (`rule_code = fact_code`, decisions.md #3). Code-defined, never seeded.
//!
//! Append protocol: one line per rule in the `rules!` block below. The DB only
//! checks the code's format, so adding a rule needs no migration.

use console_kernel_core::KernelError;
use serde::{Deserialize, Serialize};

/// Who must stand behind an exception (backend-work BW-06).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Risk {
    /// Recorded only.
    Low,
    /// Step-up only.
    Medium,
    /// A second person when one is eligible; otherwise the sole-holder fallback.
    High,
}

impl Risk {
    #[must_use]
    pub const fn as_db_str(self) -> &'static str {
        match self {
            Self::Low => "LOW",
            Self::Medium => "MEDIUM",
            Self::High => "HIGH",
        }
    }
}

/// Whether a rule overrides a soft rule or attests an offline fact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleKind {
    SoftRule,
    Fact,
}

macro_rules! rules {
    ($($variant:ident => $code:literal, $risk:ident, $kind:ident;)+) => {
        /// A registered rule code. Serialized as its SCREAMING_SNAKE code.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum RuleCode {
            $(#[serde(rename = $code)] $variant,)+
        }

        impl RuleCode {
            pub const ALL: &'static [RuleCode] = &[$(RuleCode::$variant,)+];

            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $code,)+ }
            }

            #[must_use]
            pub const fn risk(self) -> Risk {
                match self { $(Self::$variant => Risk::$risk,)+ }
            }

            #[must_use]
            pub const fn kind(self) -> RuleKind {
                match self { $(Self::$variant => RuleKind::$kind,)+ }
            }

            /// Unknown codes are a 422 `exception_rule_unknown`.
            pub fn parse(value: &str) -> Result<Self, KernelError> {
                match value {
                    $($code => Ok(Self::$variant),)+
                    _ => Err(KernelError::validation("exception_rule_unknown")),
                }
            }
        }
    };
}

rules! {
    // Soft-rule exceptions (backend-work BW-06, decisions.md #5/#7/#8a/#10 and the BW-06 amendments).
    SiblingNameDuplicate => "SIBLING_NAME_DUPLICATE", Low, SoftRule;
    DuplicateNameConfirmed => "DUPLICATE_NAME_CONFIRMED", Low, SoftRule;
    NonEmployeeAccount => "NON_EMPLOYEE_ACCOUNT", Low, SoftRule;
    ExitDateFarFuture => "EXIT_DATE_FAR_FUTURE", Low, SoftRule;
    ExitDateMismatchDerived => "EXIT_DATE_MISMATCH_DERIVED", Low, SoftRule;
    SameReporterConfirmer => "SAME_REPORTER_CONFIRMER", Medium, SoftRule;
    SameHrHq => "SAME_HR_HQ", Medium, SoftRule;
    ExitDateBackdated => "EXIT_DATE_BACKDATED", Medium, SoftRule;
    RetroSettlementDeferred => "RETRO_SETTLEMENT_DEFERRED", Medium, SoftRule;
    ExportDeclined => "EXPORT_DECLINED", Medium, SoftRule;
    LifecycleBackdatedClosedPeriod => "LIFECYCLE_BACKDATED_CLOSED_PERIOD", High, SoftRule;
    OrgChangeBackdated => "ORG_CHANGE_BACKDATED", High, SoftRule;
    FixedTermOverTwoYears => "FIXED_TERM_OVER_TWO_YEARS", High, SoftRule;
    SettlementWageDeviation => "SETTLEMENT_WAGE_DEVIATION", High, SoftRule;
    ElevatedRoleSingleAdmin => "ELEVATED_ROLE_SINGLE_ADMIN", High, SoftRule;
    HeadcountClassOverride => "HEADCOUNT_CLASS_OVERRIDE", High, SoftRule;
    SecondPersonSharedAuthenticator => "SECOND_PERSON_SHARED_AUTHENTICATOR", High, SoftRule;
    // ENT-REG (MR-17): 사업자 구분 / 법인등록번호 / 사업자등록번호 corrected after 운영 시작.
    EntityIdentifierCorrection => "ENTITY_IDENTIFIER_CORRECTION", High, SoftRule;
    // A sole holder unlocks a closed period with no other eligible holder (#7 case B, #8b).
    PeriodUnlockSoleHolder => "PERIOD_UNLOCK_SOLE_HOLDER", High, SoftRule;
    LifecycleItemWaived => "LIFECYCLE_ITEM_WAIVED", High, SoftRule;
    // Attested offline facts (decisions.md #3). Step-up (MEDIUM) where the fact closes a legal clock.
    LifecycleItemAttested => "LIFECYCLE_ITEM_ATTESTED", Medium, Fact;
    ResignationReceived => "RESIGNATION_RECEIVED", Low, Fact;
    DismissalNoticeDelivered => "DISMISSAL_NOTICE_DELIVERED", Low, Fact;
    PaymentDueExtensionAgreed => "PAYMENT_DUE_EXTENSION_AGREED", Medium, Fact;
    IrpTransferException => "IRP_TRANSFER_EXCEPTION", Low, Fact;
    EarlyLossReportRequested => "EARLY_LOSS_REPORT_REQUESTED", Low, Fact;
    SeparationCertificateRequested => "SEPARATION_CERTIFICATE_REQUESTED", Low, Fact;
    EmploymentCertificateRequested => "EMPLOYMENT_CERTIFICATE_REQUESTED", Low, Fact;
    InsuranceLossReported => "INSURANCE_LOSS_REPORTED", Medium, Fact;
    FinalPayCompleted => "FINAL_PAY_COMPLETED", Medium, Fact;
    SettlementItemAttested => "SETTLEMENT_ITEM_ATTESTED", Medium, Fact;
    ResignationWithdrawn => "RESIGNATION_WITHDRAWN", Low, Fact;
}

/// What an exception is about. The retro guard covers the first three
/// (decisions.md #5); the rest carry the other named rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SubjectType {
    EmploymentEvent,
    AttendanceRecord,
    OrgChange,
    ExitCase,
    Employee,
    UserAccount,
    PayrollRun,
    Organization,
    /// A 법인 (ENT-REG identifier corrections).
    LegalEntity,
    /// A 사업자등록 (ENT-REG 사업자등록번호 corrections).
    BusinessRegistration,
    PeriodLock,
    /// A lifecycle case item's attestation or waiver (lifecycle-events §6.2).
    LifecycleCaseItem,
}

impl SubjectType {
    pub const ALL: &'static [SubjectType] = &[
        Self::EmploymentEvent,
        Self::AttendanceRecord,
        Self::OrgChange,
        Self::ExitCase,
        Self::Employee,
        Self::UserAccount,
        Self::PayrollRun,
        Self::Organization,
        Self::LegalEntity,
        Self::BusinessRegistration,
        Self::PeriodLock,
        Self::LifecycleCaseItem,
    ];

    #[must_use]
    pub const fn as_db_str(self) -> &'static str {
        match self {
            Self::EmploymentEvent => "EMPLOYMENT_EVENT",
            Self::AttendanceRecord => "ATTENDANCE_RECORD",
            Self::OrgChange => "ORG_CHANGE",
            Self::ExitCase => "EXIT_CASE",
            Self::Employee => "EMPLOYEE",
            Self::UserAccount => "USER_ACCOUNT",
            Self::PayrollRun => "PAYROLL_RUN",
            Self::Organization => "ORGANIZATION",
            Self::LegalEntity => "LEGAL_ENTITY",
            Self::BusinessRegistration => "BUSINESS_REGISTRATION",
            Self::PeriodLock => "PERIOD_LOCK",
            Self::LifecycleCaseItem => "LIFECYCLE_CASE_ITEM",
        }
    }

    pub fn from_db_str(value: &str) -> Result<Self, KernelError> {
        Self::ALL
            .iter()
            .copied()
            .find(|s| s.as_db_str() == value)
            .ok_or_else(|| KernelError::validation("exception_subject_unknown"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_rule_code_round_trips_and_is_db_shaped() {
        for &rule in RuleCode::ALL {
            assert_eq!(RuleCode::parse(rule.as_str()).unwrap(), rule);
            let code = rule.as_str();
            // Mirrors the bw06.sql CHECK `^[A-Z][A-Z0-9_]{2,63}$`.
            assert!((3..=64).contains(&code.len()), "{code}");
            assert!(code.starts_with(|c: char| c.is_ascii_uppercase()), "{code}");
            assert!(
                code.chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            );
        }
        assert!(RuleCode::parse("NOT_A_RULE").is_err());
    }

    #[test]
    fn spec_tiers_hold() {
        assert_eq!(RuleCode::SiblingNameDuplicate.risk(), Risk::Low);
        assert_eq!(RuleCode::SameReporterConfirmer.risk(), Risk::Medium);
        assert_eq!(RuleCode::SettlementItemAttested.risk(), Risk::Medium);
        assert_eq!(RuleCode::LifecycleBackdatedClosedPeriod.risk(), Risk::High);
        assert_eq!(RuleCode::HeadcountClassOverride.risk(), Risk::High);
        assert_eq!(RuleCode::ExitDateBackdated.risk(), Risk::Medium);
        assert_eq!(RuleCode::ExitDateFarFuture.risk(), Risk::Low);
        assert_eq!(RuleCode::RetroSettlementDeferred.risk(), Risk::Medium);
        assert_eq!(RuleCode::EntityIdentifierCorrection.risk(), Risk::High);
    }

    #[test]
    fn subject_types_round_trip() {
        for &s in SubjectType::ALL {
            assert_eq!(SubjectType::from_db_str(s.as_db_str()).unwrap(), s);
        }
        assert!(SubjectType::from_db_str("employment_event").is_err());
    }
}
