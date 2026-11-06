// SPDX-License-Identifier: LicenseRef-Proprietary
//! Attention is a view of source-authorized work, never a second authorization path.
use crate::{ActionInboxItem, InboxFilter};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Attention {
    #[default]
    All,
    Approvals,
    Today,
    Overdue,
}

impl Attention {
    pub(crate) fn is_exact(self, incomplete: &[crate::ActionInboxSource], first: bool) -> bool {
        first
            && !incomplete
                .iter()
                .any(|source| self.filter().includes_source(*source))
    }

    pub fn filter(self) -> InboxFilter {
        match self {
            Self::All => InboxFilter::All,
            Self::Approvals => InboxFilter::Approvals,
            Self::Today => InboxFilter::Today,
            Self::Overdue => InboxFilter::Overdue,
        }
    }

    pub(crate) fn includes(self, item: &ActionInboxItem) -> bool {
        match self {
            Self::All => true,
            Self::Approvals => is_approval(&item.kind),
            Self::Today => item.lane == "turn" && item.days_remaining == Some(0),
            Self::Overdue => item.due_tone == "danger",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AttentionCount {
    pub key: Attention,
    pub total: usize,
    pub total_is_exact: bool,
}

pub(crate) fn counts(items: &[ActionInboxItem], exact: bool) -> Vec<AttentionCount> {
    [
        Attention::All,
        Attention::Approvals,
        Attention::Today,
        Attention::Overdue,
    ]
    .into_iter()
    .map(|key| AttentionCount {
        key,
        total: items.iter().filter(|item| key.includes(item)).count(),
        total_is_exact: exact,
    })
    .collect()
}

fn is_approval(kind: &str) -> bool {
    matches!(
        kind,
        "approval"
            | "org_change_approve"
            | "payroll"
            | "governance"
            | "period_unlock"
            | "support_access"
            | "identifier_correction_decide"
    )
}
