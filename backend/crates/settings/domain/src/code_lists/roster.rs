//! The reason domains and their system codes. System codes are code-defined
//! (never seeded rows): the BW-07 migration's `system_reason_codes()` is
//! generated from this roster and pinned by a test. Labels live in the
//! frontend catalog, keyed `<domain>.<code>`; the BW-07 migration header maps
//! each code to its Korean seed label for that catalog.
//!
//! Sources: `backend-work.md` BW-07, amended by `decisions.md` (BW-07 block,
//! §9 Table A for `exit_reason`, the `retained_record_purpose` list).

use serde::Serialize;

/// One system code. Wire strings never change once shipped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SystemCode {
    pub code: &'static str,
    /// A note must accompany this code.
    pub requires_note: bool,
}

/// "Other": last in every domain, always needs a note.
pub const OTHER: SystemCode = SystemCode {
    code: "OTHER",
    requires_note: true,
};

/// A requested domain string that names no registered domain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownDomain(pub String);

impl std::fmt::Display for UnknownDomain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "unknown reason domain: {}", self.0)
    }
}

impl std::error::Error for UnknownDomain {}

macro_rules! reason_domains {
    ($($variant:ident => $wire:literal [$($code:literal),* $(,)?];)+) => {
        /// A reason-code domain: the command family a reason belongs to.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        pub enum ReasonDomain {
            $(#[serde(rename = $wire)] $variant,)+
        }

        impl ReasonDomain {
            /// Every domain, in declaration order.
            pub const ALL: &'static [Self] = &[$(Self::$variant,)+];

            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $wire,)+ }
            }

            /// The system codes, in display order; [`OTHER`] is last.
            #[must_use]
            pub const fn system_codes(self) -> &'static [SystemCode] {
                match self {
                    $(Self::$variant => {
                        const CODES: &[SystemCode] = &[
                            $(SystemCode { code: $code, requires_note: false },)*
                            OTHER,
                        ];
                        CODES
                    })+
                }
            }
        }

        impl std::str::FromStr for ReasonDomain {
            type Err = UnknownDomain;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                match value {
                    $($wire => Ok(Self::$variant),)+
                    _ => Err(UnknownDomain(value.to_owned())),
                }
            }
        }
    };
}

reason_domains! {
    // --- org change (BW-01/02) ---
    OrgChangeReason => "org_change_reason" [
        "NEW_BUSINESS_SITE", "CONSOLIDATION", "WORK_REALLOCATION", "RENAMING",
        "COMPLIANCE_FINDING",
    ];
    OrgChangeReject => "org_change_reject" [
        "EFFECTIVE_DATE_REVIEW", "INSUFFICIENT_BASIS", "WRONG_TARGET", "POLICY_VIOLATION",
    ];
    ApprovalReturn => "approval_return" [
        "NEEDS_SUPPLEMENT", "ADD_EVIDENCE", "ADJUST_EFFECTIVE_DATE", "CORRECT_TARGET",
    ];
    OrgChangeCancel => "org_change_cancel" ["DUPLICATE_DRAFT", "PLAN_CHANGED", "DRAFTING_ERROR"];
    OrgChangeWithdraw => "org_change_withdraw" ["DUPLICATE_DRAFT", "PLAN_CHANGED", "DRAFTING_ERROR"];
    // --- lifecycle (BW-11/12/13); leave reasons are `leave_type`, not a domain ---
    LifecycleTransfer => "lifecycle_transfer" [
        "REGULAR_RESHUFFLE", "REORGANIZATION", "EMPLOYEE_REQUEST", "BUSINESS_NEED",
    ];
    LifecyclePromote => "lifecycle_promote" [
        "REGULAR_PROMOTION", "SPECIAL_PROMOTION", "DISCIPLINARY_DEMOTION",
    ];
    LifecycleCancel => "lifecycle_cancel" ["INPUT_ERROR", "SCHEDULE_CHANGED", "PLAN_WITHDRAWN"];
    // --- exits (BW-04/08). Insurance-code mapping and `requires_detail` are BW-08 (HOLD) ---
    ExitReason => "exit_reason" [
        "PERSONAL", "FAMILY", "ILLNESS", "STUDY",
        "WORKING_CONDITIONS", "WAGE_ARREARS", "RELOCATION",
        "CLOSURE", "INSOLVENCY",
        "ADVISED_RESIGNATION_BUSINESS", "REDUNDANCY_DISMISSAL",
        "DISCIPLINARY_DISMISSAL", "ADVISED_RESIGNATION_FAULT",
        "RETIREMENT_AGE", "CONTRACT_END", "PROJECT_END",
        "COVERAGE_EXCLUDED", "DUAL_EMPLOYMENT", "DEATH",
    ];
    ExitReject => "exit_reject" ["EMPLOYEE_WITHDREW", "NOT_FACTUAL"];
    ExitCancel => "exit_cancel" ["EMPLOYEE_WITHDREW", "REPORT_ERROR"];
    // --- period locks (BW-15) ---
    PeriodLock => "period_lock" ["MONTHLY_PAYROLL_CLOSE", "BOOKS_CLOSE", "TAX_FILING", "AUDIT_RESPONSE"];
    PeriodUnlock => "period_unlock" ["RETRO_CORRECTION", "PAYROLL_ERROR", "AUDIT_FINDING"];
    // --- accounts (BW-14/34); stored in the audit snapshot, not a column ---
    RoleChange => "role_change" [
        "PROMOTION_OR_REASSIGNMENT", "EXIT_OR_LEAVE", "ACCESS_CLEANUP", "ERROR_CORRECTION",
    ];
    Deactivate => "deactivate" ["EXIT", "LEAVE", "SECURITY_INCIDENT", "DUPLICATE_ACCOUNT"];
    CredentialReset => "credential_reset" ["DEVICE_LOST", "DEVICE_REPLACED", "COMPROMISE_SUSPECTED"];
    // --- import (BW-10) ---
    ImportExclude => "import_exclude" ["DUPLICATE", "FORMAT_ERROR", "OUT_OF_SCOPE"];
    // --- governed exceptions (BW-06) ---
    // OTHER only; per-rule codes are F-EXC's to add here.
    Exception => "exception" [];
    // --- retained records after exit (decisions #10) ---
    RetainedRecordPurpose => "retained_record_purpose" [
        "EMPLOYMENT_CERTIFICATE", "SEPARATION_CONFIRMATION", "PAYMENT_STATEMENT_FILING",
        "WITHHOLDING_CORRECTION", "EXIT_PROCESSING_COMPLETION", "DISPUTE_OR_INSPECTION",
        "DATA_SUBJECT_ACCESS",
    ];
    // --- restricted 인사카드 sections: 징계, 장애, 보훈 (EMP-RECORD MR-33/35) ---
    RestrictedRecordPurpose => "restricted_record_purpose" [
        "STATUTORY_REPORTING", "WORK_ACCOMMODATION", "DISCIPLINARY_PROCEDURE",
        "RECORD_CORRECTION", "DISPUTE_OR_INSPECTION", "DATA_SUBJECT_ACCESS",
    ];
    // --- IMPORT-2 (decisions #25): 주민등록번호 열람, 사번 변경 ---
    RrnReveal => "rrn_reveal" [
        "PAYROLL_WITHHOLDING", "SOCIAL_INSURANCE_FILING", "IDENTITY_VERIFICATION",
        "DATA_SUBJECT_ACCESS",
    ];
    EmployeeNumberChange => "employee_number_change" [
        "NUMBERING_SCHEME_CHANGE", "ENTITY_TRANSFER", "INPUT_ERROR", "LEGACY_MIGRATION",
    ];
    // --- AUTH-ID (decisions #33): 아이디 변경 ---
    SignInIdChange => "sign_in_id_change" [
        "NAME_CHANGE", "INPUT_ERROR", "HOLDER_REQUEST", "SECURITY_INCIDENT",
    ];
}

impl ReasonDomain {
    /// The domain accepts tenant codes (governance design S3, the roster
    /// `tenant_extensible` flag). Governance domains are closed so a vague
    /// tenant code cannot turn them back into free text; the other closed
    /// domains of that list arrive with their roster entries.
    #[must_use]
    pub const fn tenant_extensible(self) -> bool {
        !matches!(self, Self::Exception)
    }
}
