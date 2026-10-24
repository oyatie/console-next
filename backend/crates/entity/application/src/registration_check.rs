// SPDX-License-Identifier: LicenseRef-Proprietary
//! Pack-neutral issuing-authority checks. Scheduled work can send only numbers.
use console_entity_domain::codes::OperatingStatus;
use serde::{Deserialize, Serialize};
use std::{future::Future, pin::Pin};

type CheckFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, CheckFailure>> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CheckKind {
    Status,
    Validate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum UnavailableReason {
    NotConfigured,
    KeyExpired,
    KeyRejected,
    ProviderDown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckAvailability {
    pub available: bool,
    pub reason: Option<UnavailableReason>,
}
impl CheckAvailability {
    #[must_use]
    pub const fn available() -> Self {
        Self {
            available: true,
            reason: None,
        }
    }
    #[must_use]
    pub const fn unavailable(reason: UnavailableReason) -> Self {
        Self {
            available: false,
            reason: Some(reason),
        }
    }
}

/// Errors contain codes only, never provider bodies, request values or URLs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckFailure {
    Unavailable(UnavailableReason),
    RateLimited {
        retry_after_seconds: u64,
        gateway_code: Option<String>,
    },
    Contract {
        code: &'static str,
    },
}

/// User action only: the purpose is recorded without copying the personal values.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UserValidation {
    pub brn: String,
    pub opened_on: String,
    pub representative: String,
}
impl std::fmt::Debug for UserValidation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("UserValidation([redacted])")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckAnswer {
    pub brn_checked: String,
    pub kind: CheckKind,
    pub status_code: Option<String>,
    /// The pack adapter alone maps its status to the tenant's vocabulary.
    pub reported_status: Option<OperatingStatus>,
    pub tax_type_cd: Option<String>,
    pub end_dt: Option<String>,
    pub utcc_yn: Option<String>,
    pub tax_type_change_dt: Option<String>,
    pub invoice_apply_dt: Option<String>,
    pub rbf_tax_type_cd: Option<String>,
    pub valid: Option<String>,
    pub not_registered: bool,
    pub fields_sent: Vec<String>,
    pub response_sha256: String,
    pub provider_version: String,
}
impl CheckAnswer {
    #[must_use]
    pub fn status(brn: &str, status_code: &str) -> Self {
        Self {
            brn_checked: brn.into(),
            kind: CheckKind::Status,
            status_code: (!status_code.is_empty()).then(|| status_code.into()),
            reported_status: None,
            tax_type_cd: None,
            end_dt: None,
            utcc_yn: None,
            tax_type_change_dt: None,
            invoice_apply_dt: None,
            rbf_tax_type_cd: None,
            valid: None,
            not_registered: status_code.is_empty(),
            fields_sent: vec!["b_no".into()],
            response_sha256: String::new(),
            provider_version: String::new(),
        }
    }
}

#[must_use]
pub fn verification_tier(number: Option<&str>, latest: Option<&CheckAnswer>) -> &'static str {
    let Some(answer) = latest.filter(|a| number == Some(a.brn_checked.as_str())) else {
        return "NONE";
    };
    if answer.kind == CheckKind::Validate && answer.valid.as_deref() == Some("01") {
        "T2"
    } else if answer.status_code.is_some() && !answer.not_registered {
        "T1"
    } else {
        "NONE"
    }
}

/// The schedule has no validation command: it cannot send personal data.
pub trait RegistrationCheck: Send + Sync {
    fn reflection_lag_days(&self) -> i64;
    fn max_batch(&self) -> usize;
    fn pack(&self) -> &'static str;
    fn availability(&self) -> CheckAvailability;
    fn status<'a>(&'a self, numbers: &'a [String]) -> CheckFuture<'a, Vec<CheckAnswer>>;
    fn validate<'a>(&'a self, request: &'a UserValidation) -> CheckFuture<'a, CheckAnswer>;
}

#[derive(Debug, Clone)]
pub struct FakeRegistrationCheck {
    availability: CheckAvailability,
    answers: Vec<CheckAnswer>,
}
impl FakeRegistrationCheck {
    #[must_use]
    pub fn configured(answers: Vec<CheckAnswer>) -> Self {
        Self {
            availability: CheckAvailability::available(),
            answers,
        }
    }
    #[must_use]
    pub fn unavailable(reason: UnavailableReason) -> Self {
        Self {
            availability: CheckAvailability::unavailable(reason),
            answers: vec![],
        }
    }
    fn answers(&self) -> Result<Vec<CheckAnswer>, CheckFailure> {
        self.availability.reason.map_or_else(
            || Ok(self.answers.clone()),
            |r| Err(CheckFailure::Unavailable(r)),
        )
    }
}
impl RegistrationCheck for FakeRegistrationCheck {
    fn reflection_lag_days(&self) -> i64 {
        2
    }
    fn max_batch(&self) -> usize {
        100
    }
    fn pack(&self) -> &'static str {
        "KR"
    }
    fn availability(&self) -> CheckAvailability {
        self.availability
    }
    fn status<'a>(&'a self, numbers: &'a [String]) -> CheckFuture<'a, Vec<CheckAnswer>> {
        Box::pin(async move {
            Ok(self
                .answers()?
                .into_iter()
                .filter(|a| numbers.contains(&a.brn_checked))
                .collect())
        })
    }
    fn validate<'a>(&'a self, request: &'a UserValidation) -> CheckFuture<'a, CheckAnswer> {
        Box::pin(async move {
            self.answers()?
                .into_iter()
                .find(|a| a.brn_checked == request.brn && a.kind == CheckKind::Validate)
                .ok_or(CheckFailure::Contract {
                    code: "fake_answer_missing",
                })
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckEvidence {
    pub id: uuid::Uuid,
    pub registration_id: uuid::Uuid,
    #[serde(flatten)]
    pub answer: CheckAnswer,
    #[serde(with = "time::serde::rfc3339")]
    pub checked_at: time::OffsetDateTime,
    pub trigger: String,
    pub actor_id: Option<uuid::Uuid>,
    pub recorded_status_mismatch: bool,
    pub reflection_pending: bool,
    pub inbox_item_id: Option<uuid::Uuid>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckHistory {
    pub items: Vec<CheckEvidence>,
    pub latest_status: Option<CheckEvidence>,
    pub latest_validate: Option<CheckEvidence>,
    pub next_cursor: Option<uuid::Uuid>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RegistrationCheckItem {
    pub id: uuid::Uuid,
    pub registration_id: uuid::Uuid,
    pub legal_entity_id: uuid::Uuid,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: time::OffsetDateTime,
}

/// Consumer mounts this source after its inbox integration is ready.
pub trait RegistrationCheckInbox: Send + Sync {
    fn list_check_items<'a>(
        &'a self,
        actor: &'a crate::Actor,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<Vec<RegistrationCheckItem>, console_kernel_core::KernelError>,
                > + Send
                + 'a,
        >,
    >;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewAcceptance {
    pub command_id: uuid::Uuid,
    pub acknowledged: bool,
    pub status_since: Option<String>,
}
