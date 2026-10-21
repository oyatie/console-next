use crate::*;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OrgChangeKind {
    New,
    Reorg,
    Dissolve,
}

impl OrgChangeKind {
    #[must_use]
    pub const fn as_db(self) -> &'static str {
        match self {
            Self::New => "NEW",
            Self::Reorg => "REORG",
            Self::Dissolve => "DISSOLVE",
        }
    }

    pub fn from_db(value: &str) -> Result<Self, KernelError> {
        match value {
            "NEW" => Ok(Self::New),
            "REORG" => Ok(Self::Reorg),
            "DISSOLVE" => Ok(Self::Dissolve),
            _ => Err(KernelError::validation("unknown org-change kind")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OrgChangeStatus {
    Draft,
    Prechecked,
    InApproval,
    Approved,
    Applied,
    Settling,
    Archived,
    Rejected,
    Cancelled,
}

impl OrgChangeStatus {
    #[must_use]
    pub const fn as_db(self) -> &'static str {
        match self {
            Self::Draft => "DRAFT",
            Self::Prechecked => "PRECHECKED",
            Self::InApproval => "IN_APPROVAL",
            Self::Approved => "APPROVED",
            Self::Applied => "APPLIED",
            Self::Settling => "SETTLING",
            Self::Archived => "ARCHIVED",
            Self::Rejected => "REJECTED",
            Self::Cancelled => "CANCELLED",
        }
    }

    pub fn from_db(value: &str) -> Result<Self, KernelError> {
        match value {
            "DRAFT" => Ok(Self::Draft),
            "PRECHECKED" => Ok(Self::Prechecked),
            "IN_APPROVAL" => Ok(Self::InApproval),
            "APPROVED" => Ok(Self::Approved),
            "APPLIED" => Ok(Self::Applied),
            "SETTLING" => Ok(Self::Settling),
            "ARCHIVED" => Ok(Self::Archived),
            "REJECTED" => Ok(Self::Rejected),
            "CANCELLED" => Ok(Self::Cancelled),
            _ => Err(KernelError::conflict("unknown org-change status")),
        }
    }

    /// Terminal statuses accept no further transition (append-only history;
    /// a rejected request is revised as a NEW row via `supersedes_id`).
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Applied | Self::Archived | Self::Rejected | Self::Cancelled
        )
    }

    /// The draft-editable window: draft fields (kind, effective date, reason,
    /// proposal) may only change here, and cancel is only legal here.
    #[must_use]
    pub const fn is_draft_editable(self) -> bool {
        matches!(self, Self::Draft | Self::Prechecked)
    }

    pub fn can_transition_to(self, next: Self) -> Result<(), KernelError> {
        let allowed = matches!(
            (self, next),
            // Preflight persists nothing, so submit drives DRAFT → IN_APPROVAL
            // directly off a receipt recomputed in the submit transaction.
            (Self::Draft, Self::InApproval)
                // DRAFT → PRECHECKED is deliberately absent: nothing may
                // promote a draft on the strength of a preflight run. PRECHECKED
                // is now an inbound-only legacy state — rows already stored in
                // it keep every exit they had.
                | (Self::Prechecked, Self::Draft)
                | (Self::Prechecked, Self::InApproval)
                | (Self::InApproval, Self::Approved | Self::Rejected)
                // approval.policy.org_structure = none (decisions #26): submit
                // approves at once and creates no step.
                | (Self::Draft | Self::Prechecked, Self::Approved)
                // Every kind applies on its 시행일 (org-05: a 폐지 no longer
                // opens settlement). SETTLING is an inbound-only legacy state:
                // rows already stored in it still archive.
                | (Self::Approved, Self::Applied)
                | (Self::Settling, Self::Archived)
                // org-02: a scheduled change (APPROVED, its 시행일 not come)
                // is cancelled like a draft.
                | (Self::Draft | Self::Prechecked | Self::Approved, Self::Cancelled)
        );
        if allowed {
            Ok(())
        } else {
            Err(KernelError::conflict(
                "illegal org-change status transition",
            ))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TargetKind {
    Entity,
    Region,
    Branch,
    Site,
    OrgUnit,
}

impl TargetKind {
    #[must_use]
    pub const fn as_db(self) -> &'static str {
        match self {
            Self::Entity => "ENTITY",
            Self::Region => "REGION",
            Self::Branch => "BRANCH",
            Self::Site => "SITE",
            Self::OrgUnit => "ORG_UNIT",
        }
    }

    pub fn from_db(value: &str) -> Result<Self, KernelError> {
        match value {
            "ENTITY" => Ok(Self::Entity),
            "REGION" => Ok(Self::Region),
            "BRANCH" => Ok(Self::Branch),
            "SITE" => Ok(Self::Site),
            "ORG_UNIT" => Ok(Self::OrgUnit),
            _ => Err(KernelError::validation("unknown org-change target kind")),
        }
    }
}

/// Ordered SoD chain roles (HR → 재무 → 법무 → 임원), fixed in slice 1; the
/// step table's `role_key TEXT + step_order` shape already accommodates a
/// configurable approval matrix later without a migration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalRoleKey {
    Hr,
    Finance,
    Legal,
    Executive,
}

impl ApprovalRoleKey {
    pub const ORDER: [Self; 4] = [Self::Hr, Self::Finance, Self::Legal, Self::Executive];

    #[must_use]
    pub const fn as_db(self) -> &'static str {
        match self {
            Self::Hr => "hr",
            Self::Finance => "finance",
            Self::Legal => "legal",
            Self::Executive => "executive",
        }
    }

    pub fn from_db(value: &str) -> Result<Self, KernelError> {
        match value {
            "hr" => Ok(Self::Hr),
            "finance" => Ok(Self::Finance),
            "legal" => Ok(Self::Legal),
            "executive" => Ok(Self::Executive),
            _ => Err(KernelError::conflict("unknown approval role key")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StepDecision {
    Pending,
    Approved,
    Rejected,
}

impl StepDecision {
    #[must_use]
    pub const fn as_db(self) -> &'static str {
        match self {
            Self::Pending => "PENDING",
            Self::Approved => "APPROVED",
            Self::Rejected => "REJECTED",
        }
    }

    pub fn from_db(value: &str) -> Result<Self, KernelError> {
        match value {
            "PENDING" => Ok(Self::Pending),
            "APPROVED" => Ok(Self::Approved),
            "REJECTED" => Ok(Self::Rejected),
            _ => Err(KernelError::conflict("unknown step decision")),
        }
    }
}

/// The six dissolve settlement items (§3.9.3), seeded at effectuate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SettlementKey {
    TransferEmployees,
    Positions,
    CostCenters,
    CloseOpenDocs,
    Assets,
    PayrollSocialFinal,
}

impl SettlementKey {
    pub const ALL: [Self; 6] = [
        Self::TransferEmployees,
        Self::Positions,
        Self::CostCenters,
        Self::CloseOpenDocs,
        Self::Assets,
        Self::PayrollSocialFinal,
    ];

    #[must_use]
    pub const fn as_db(self) -> &'static str {
        match self {
            Self::TransferEmployees => "TRANSFER_EMPLOYEES",
            Self::Positions => "POSITIONS",
            Self::CostCenters => "COST_CENTERS",
            Self::CloseOpenDocs => "CLOSE_OPEN_DOCS",
            Self::Assets => "ASSETS",
            Self::PayrollSocialFinal => "PAYROLL_SOCIAL_FINAL",
        }
    }

    /// Server-issued display label (design §3.9.3 settlement list).
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::TransferEmployees => "소속 직원 전보·전적(동의·통지 기간)",
            Self::Positions => "포지션 이관·폐지",
            Self::CostCenters => "코스트센터·예산 재배정",
            Self::CloseOpenDocs => "진행 중 공고·결재 종결",
            Self::Assets => "자산 이관·반납",
            Self::PayrollSocialFinal => "급여·4대보험·퇴직 정산",
        }
    }
}
