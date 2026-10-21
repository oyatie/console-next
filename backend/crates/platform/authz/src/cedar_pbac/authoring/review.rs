use console_kernel_core::KernelError;

// ---------------------------------------------------------------------------
// Draft review lifecycle (four-eyes)
// ---------------------------------------------------------------------------

/// Draft review state, mirroring the `cedar_policy_drafts.review_status` CHECK.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewStatus {
    Draft,
    ReviewPending,
    Rejected,
    ApprovedForPromotion,
}

impl ReviewStatus {
    #[must_use]
    pub const fn as_db_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::ReviewPending => "review_pending",
            Self::Rejected => "rejected",
            Self::ApprovedForPromotion => "approved_for_promotion",
        }
    }

    pub fn from_db_str(raw: &str) -> Result<Self, KernelError> {
        match raw {
            "draft" => Ok(Self::Draft),
            "review_pending" => Ok(Self::ReviewPending),
            "rejected" => Ok(Self::Rejected),
            "approved_for_promotion" => Ok(Self::ApprovedForPromotion),
            _ => Err(KernelError::validation(format!(
                "unknown draft review_status {raw:?}"
            ))),
        }
    }
}

/// A four-eyes review decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecision {
    Approve,
    Reject,
}

/// Compute the review status after `submit`. A draft may be submitted for review
/// only from `draft`/`rejected` and only when its last validation was `valid`
/// (mirrors the `review_status <> 'review_pending' OR validation = 'valid'` CHECK).
pub fn submit_draft(
    current: ReviewStatus,
    validation_valid: bool,
) -> Result<ReviewStatus, KernelError> {
    if !validation_valid {
        return Err(KernelError::validation(
            "a draft must validate before it can be submitted for review",
        ));
    }
    match current {
        ReviewStatus::Draft | ReviewStatus::Rejected => Ok(ReviewStatus::ReviewPending),
        ReviewStatus::ReviewPending => {
            Err(KernelError::conflict("draft is already pending review"))
        }
        ReviewStatus::ApprovedForPromotion => Err(KernelError::conflict(
            "draft is already approved for promotion",
        )),
    }
}

/// Compute the review status after a four-eyes decision. The reviewer MUST differ
/// from the author (self-review blocked), and the draft must be `review_pending`.
/// Approval yields `approved_for_promotion` — NOT an enforced/shadow row;
/// promotion is a separate gated lane.
pub fn review_draft(
    current: ReviewStatus,
    decision: ReviewDecision,
    author: console_kernel_core::UserId,
    reviewer: console_kernel_core::UserId,
) -> Result<ReviewStatus, KernelError> {
    if author == reviewer {
        return Err(KernelError::forbidden(
            "self-review is not allowed: reviewer must differ from the draft author",
        ));
    }
    if current != ReviewStatus::ReviewPending {
        return Err(KernelError::conflict(
            "only a review_pending draft can be reviewed",
        ));
    }
    Ok(match decision {
        ReviewDecision::Approve => ReviewStatus::ApprovedForPromotion,
        ReviewDecision::Reject => ReviewStatus::Rejected,
    })
}
