//! BW-17 change requests (변경 요청): kinds, subjects and the close rule.
//!
//! Pure: who may act (the HR tier, the branch scope) is checked by the adapter;
//! this module decides only "whether" a close is legal for these facts.

use console_kernel_core::KernelError;
use uuid::Uuid;

/// What the request asks for. `OTHER` is the unforeseen case: a note is
/// required and the request is flagged for review. `ACCESS_EXPLANATION` (the
/// 접속기록 review's 소명 요청, governance S7) and `POLICY_QUESTION` (S5's
/// 규정 검토 필요) are answered by their named assignee, who need not be HR.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeRequestKind {
    ProfileCorrection,
    IdentityReview,
    AccessRequest,
    ScopeAction,
    Other,
    AccessExplanation,
    PolicyQuestion,
    /// MR-26 등록 취소, filed only by `POST /employees/{id}/void`.
    EmployeeVoid,
}

impl ChangeRequestKind {
    pub const ALL: [Self; 8] = [
        Self::ProfileCorrection,
        Self::IdentityReview,
        Self::AccessRequest,
        Self::ScopeAction,
        Self::Other,
        Self::AccessExplanation,
        Self::PolicyQuestion,
        Self::EmployeeVoid,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ProfileCorrection => "PROFILE_CORRECTION",
            Self::IdentityReview => "IDENTITY_REVIEW",
            Self::AccessRequest => "ACCESS_REQUEST",
            Self::ScopeAction => "SCOPE_ACTION",
            Self::Other => "OTHER",
            Self::AccessExplanation => "ACCESS_EXPLANATION",
            Self::PolicyQuestion => "POLICY_QUESTION",
            Self::EmployeeVoid => "EMPLOYEE_VOID",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, KernelError> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.as_str() == raw)
            .ok_or_else(|| {
                KernelError::validation(
                    "kind must be PROFILE_CORRECTION, IDENTITY_REVIEW, ACCESS_REQUEST, SCOPE_ACTION, \
                     OTHER, ACCESS_EXPLANATION, POLICY_QUESTION or EMPLOYEE_VOID",
                )
                .with_field("kind")
            })
    }

    /// The subject types a kind may name. An employee correction or identity
    /// review is always about one employee.
    #[must_use]
    pub const fn subject_types(self) -> &'static [&'static str] {
        match self {
            Self::ProfileCorrection | Self::IdentityReview | Self::EmployeeVoid => &["EMPLOYEE"],
            Self::AccessRequest | Self::AccessExplanation => &["USER_ACCOUNT"],
            Self::PolicyQuestion => &["ORGANIZATION"],
            Self::ScopeAction | Self::Other => {
                &["EMPLOYEE", "USER_ACCOUNT", "BRANCH", "ORGANIZATION"]
            }
        }
    }

    /// `OTHER` is reviewed after the fact (the 기타 path).
    #[must_use]
    pub const fn review_required(self) -> bool {
        matches!(self, Self::Other)
    }

    /// Answered (closed APPLY/DECLINE) by the named assignee even outside the
    /// HR tier; the answer carries a note. Applying it changes no record.
    #[must_use]
    pub const fn answered_by_assignee(self) -> bool {
        matches!(self, Self::AccessExplanation | Self::PolicyQuestion)
    }
}

/// Validates a new request's shape: the subject fits the kind, OTHER carries
/// a note, and a 소명 요청 is named to the account it asks (that 취급자).
pub fn validate_new_request(
    kind: ChangeRequestKind,
    subject_type: &str,
    subject_id: Uuid,
    assignee_user_id: Option<Uuid>,
    note: Option<&str>,
) -> Result<(), KernelError> {
    if !kind.subject_types().contains(&subject_type) {
        return Err(KernelError::validation(format!(
            "subject_type {subject_type} does not fit a {} request",
            kind.as_str()
        ))
        .with_field("subject_type"));
    }
    if kind == ChangeRequestKind::Other && note.is_none_or(|note| note.trim().is_empty()) {
        return Err(KernelError::validation("an OTHER request needs a note").with_field("note"));
    }
    if kind == ChangeRequestKind::AccessExplanation && assignee_user_id != Some(subject_id) {
        return Err(KernelError::validation(
            "an ACCESS_EXPLANATION is assigned to the account it asks",
        )
        .with_field("assignee_user_id"));
    }
    Ok(())
}

/// An answer kind closes with the assignee's note (the 소명 or the reply).
pub fn validate_answer(
    kind: ChangeRequestKind,
    decision: ChangeRequestDecision,
    note: Option<&str>,
) -> Result<(), KernelError> {
    if kind.answered_by_assignee()
        && decision != ChangeRequestDecision::Withdraw
        && note.is_none_or(|note| note.trim().is_empty())
    {
        return Err(KernelError::validation("an answer needs a note").with_field("note"));
    }
    Ok(())
}

/// A close the caller asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeRequestDecision {
    Apply,
    Decline,
    Withdraw,
}

impl ChangeRequestDecision {
    pub fn parse(raw: &str) -> Result<Self, KernelError> {
        match raw {
            "APPLY" => Ok(Self::Apply),
            "DECLINE" => Ok(Self::Decline),
            "WITHDRAW" => Ok(Self::Withdraw),
            _ => Err(
                KernelError::validation("decision must be APPLY, DECLINE or WITHDRAW")
                    .with_field("decision"),
            ),
        }
    }

    /// The status the request closes in.
    #[must_use]
    pub const fn closed_status(self) -> &'static str {
        match self {
            Self::Apply => "APPLIED",
            Self::Decline => "DECLINED",
            Self::Withdraw => "WITHDRAWN",
        }
    }
}

/// Why a close is refused; the adapter maps each to its wire code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseRefusal {
    /// The request is no longer OPEN.
    AlreadyClosed,
    /// The requester tried to apply or decline their own request.
    SelfDecision,
    /// Only the requester withdraws.
    NotRequester,
    /// A named assignee exists and the actor is someone else.
    NotAssignee,
}

/// Whether `actor` may close a request in `status` with `decision`. Apply and
/// decline are a second person's (never the requester, and the named
/// assignee when there is one); withdraw is the requester's alone.
pub fn check_close(
    status: &str,
    requested_by: Uuid,
    assignee_user_id: Option<Uuid>,
    actor: Uuid,
    decision: ChangeRequestDecision,
) -> Result<(), CloseRefusal> {
    if status != "OPEN" {
        return Err(CloseRefusal::AlreadyClosed);
    }
    match decision {
        ChangeRequestDecision::Withdraw if actor != requested_by => Err(CloseRefusal::NotRequester),
        ChangeRequestDecision::Withdraw => Ok(()),
        _ if actor == requested_by => Err(CloseRefusal::SelfDecision),
        _ if assignee_user_id.is_some_and(|assignee| assignee != actor) => {
            Err(CloseRefusal::NotAssignee)
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests;
