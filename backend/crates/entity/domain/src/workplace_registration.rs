// SPDX-License-Identifier: LicenseRef-Proprietary
//! Workplace registration answer (AD-ENT02 #46 / brief 159).
//!
//! A 사업장 answers three independent questions:
//! 1. 국세청 사업자등록:
//!    - Registered (under an existing or new registration)
//!    - NotRequired (with a statutory reason code from versioned reference data)
//!    - Later (아직 모름)
//! 2. 4대보험 per insurer (modeled in [`crate::insurance`])
//! 3. Physical or Abstract (abstract has no address and cannot be registered)

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::legal_entity::{CodeInput, CodeRef};
use crate::refusal::{INVALID_OPTION, Issues, REQUIRED};

/// Known statutory reason codes and labels for not registering a workplace.
pub const STATUTORY_NOT_REGISTERED_REASONS: &[(&str, &str)] = &[
    ("VAT_DEPOT", "하치장 (재화 보관·관리 장소)"),
    (
        "VAT_TEMPORARY",
        "임시사업장 (전시·행사 등 일시적 영업 장소)",
    ),
    ("REMOTE_TELEWORK", "원격·재택근무 (독립 사업장 부존재)"),
    (
        "DISPATCH_CLIENT_SITE",
        "파견·도급 상주 근무지 (고객사 현장)",
    ),
    (
        "INSURANCE_ONLY_SEPARATE",
        "4대보험·노무 전용 분리 단위 (세무상 본점 총괄)",
    ),
    (
        "PROJECT_SITE_CLUSTER",
        "프로젝트 현장 묶음 (비과세 단순 작업장)",
    ),
];

pub const REASON_VERSION_2026_10_21: &str = "2026-10-21";

/// The workplace's registration status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkplaceRegistrationAnswer {
    /// Filed under a business registration (either own or unit taxation).
    Registered {
        registration_id: Uuid,
        sub_serial: Option<String>,
    },
    /// Statutory exemption: not subject to 국세청 registration.
    NotRequired { reason: CodeRef },
    /// To be determined later (아직 모름) — a to-do and go-live blocker when staffed.
    Later,
}

/// Validate statutory reason code for an exempt workplace.
pub fn validate_not_registered_reason(
    is: &mut Issues,
    field: &str,
    raw: Option<&CodeInput>,
) -> Option<CodeRef> {
    let raw = match raw {
        Some(r) => r,
        None => {
            is.push(field, REQUIRED);
            return None;
        }
    };
    let code = match raw.code.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        Some(c) => c,
        None => {
            is.push(field, REQUIRED);
            return None;
        }
    };
    if let Some((_, label)) = STATUTORY_NOT_REGISTERED_REASONS
        .iter()
        .find(|(c, _)| *c == code)
    {
        Some(CodeRef {
            code: code.to_string(),
            label: (*label).to_string(),
            version: REASON_VERSION_2026_10_21.to_string(),
        })
    } else {
        is.push(field, INVALID_OPTION);
        None
    }
}

/// Derive filing registration for a workplace.
/// If workplace is not registered (or exempt), tax filing is derived from
/// the legal entity's primary registration (본점/총괄).
#[must_use]
pub fn derive_filing_registration(
    primary_registration_id: Option<Uuid>,
    answer: &WorkplaceRegistrationAnswer,
) -> Option<Uuid> {
    match answer {
        WorkplaceRegistrationAnswer::Registered {
            registration_id, ..
        } => Some(*registration_id),
        WorkplaceRegistrationAnswer::NotRequired { .. } | WorkplaceRegistrationAnswer::Later => {
            primary_registration_id
        }
    }
}
