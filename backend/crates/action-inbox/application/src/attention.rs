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

pub(crate) fn reason(item: &crate::ActionInboxSourceItem) -> String {
    if let Some(reason) = item
        .context
        .as_ref()
        .and_then(|c| c.get("reason"))
        .and_then(|r| r.as_str())
        .filter(|r| !r.trim().is_empty())
    {
        return reason.to_owned();
    }
    match item.kind.as_str() {
        kind if is_approval(kind) => "결재 차례입니다",
        "dispatch" => "배정 제안에 응답해 주세요",
        "support" => "배정된 지원 요청이 있습니다",
        "work" => "배정된 작업이 있습니다",
        "org_change_draft" => "기안을 마무리해 주세요",
        "org_change_rejected" => "반려 사유를 확인해 주세요",
        "org_change_apply" => "조직 변경을 시행할 차례입니다",
        "org_change_settle" => "시행 결과를 확인해 주세요",
        "hr_exit_confirm" | "hr_exit_confirm_hq" => "퇴직 확인이 필요합니다",
        "hr_exit_settle" => "퇴직 정산이 필요합니다",
        "identifier_correction_apply" => "승인된 정정을 적용해 주세요",
        "identifier_correction_review" => "기록된 정정을 확인해 주세요",
        "registration_check" => "사업자등록 확인이 필요합니다",
        "insurance_filing" => "보험 신고가 필요합니다",
        "contract_renewal" => "계약 만료를 확인해 주세요",
        "hr_request" => "정정 요청",
        "identity_review" => "신원 확인이 필요합니다",
        "unplaced" | "home_branch_review" => "사업장 배치가 필요합니다",
        "register_review" => "명부 항목 확인이 필요합니다",
        "lifecycle_apply_failed" => "예약 처리에 실패했습니다",
        "org_change_waiting" | "identifier_correction_waiting" => "다음 담당자의 처리를 기다립니다",
        "org_change_scheduled" => "시행일을 기다립니다",
        "grant_notice" => "부여된 권한을 확인해 주세요",
        "account_security" => "복구 수단을 등록해 주세요",
        kind if kind.starts_with("setup_") => "운영 준비가 필요합니다",
        _ => "처리할 업무가 있습니다",
    }
    .to_owned()
}
