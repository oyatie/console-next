//! [`super::korean_message`] exact messages, part: Platform tenant admin, period locks and exit cases.

/// Exact English message → Korean (합니다체).
pub(super) const MESSAGES: &[(&str, &str)] = &[
    // Platform tenant admin code reissue
    ("tenant was not found", "테넌트를 찾을 수 없습니다."),
    ("tenant is not active", "활성 상태의 테넌트가 아닙니다."),
    (
        "tenant has no active SUPER_ADMIN account",
        "테넌트에 활성 상태의 최고 관리자 계정이 없습니다.",
    ),
    (
        "tenant admin account is not active",
        "테넌트 관리자 계정이 활성 상태가 아닙니다.",
    ),
    (
        "tenant admin has already enrolled a passkey",
        "테넌트 관리자가 이미 패스키를 등록했습니다.",
    ),
    (
        "enroll a passkey before reissuing tenant admin codes",
        "관리자 코드를 다시 발급하려면 먼저 패스키를 등록해야 합니다.",
    ),
    // Period locks
    ("reason must not be blank", "사유를 입력해야 합니다."),
    (
        "reason must be at most 1000 characters",
        "사유는 1000자 이하여야 합니다.",
    ),
    // Exit guard refusals
    (
        "dismissal is blocked during a protected leave period",
        "해고 보호기간에는 해고할 수 없습니다.",
    ),
    (
        "written dismissal notice evidence is required",
        "해고 서면 통지 증빙을 입력하십시오.",
    ),
    (
        "an exit reason is required for HR confirmation",
        "퇴직 사유를 선택하십시오.",
    ),
    (
        "an exit case is required for termination",
        "퇴직 건을 먼저 보고하십시오.",
    ),
    (
        "reason class is only valid for exit reasons and notice requires involuntary",
        "퇴직 사유의 구분을 확인하십시오.",
    ),
    (
        "exit reason and dismissal notice belong to HR confirmation",
        "퇴직 사유와 서면 통지는 인사 확인에서만 기록할 수 있습니다.",
    ),
    (
        "dismissal notice requires pay in lieu or an evidenced statutory ground",
        "해고예고가 대장 기준보다 짧습니다. 해고예고수당 지급 또는 증빙이 있는 대장 단서를 선택하십시오.",
    ),
    (
        "a former employee's record can only be changed through a governed correction",
        "퇴직한 직원의 인사기록은 읽기 전용입니다. 변경은 정정으로 요청하십시오.",
    ),
    (
        "fixed-term contract history requires confirmation",
        "계약 이력을 기록하거나 증빙이 있는 예외를 선택하십시오.",
    ),
    (
        "the prior exit decision or its remaining settlement must be resolved or acknowledged",
        "이전 퇴직 결정이 끝나지 않았거나 남은 정산 절차를 확인하지 않았습니다.",
    ),
    // Exit cases
    ("exit case not found", "퇴사 건을 찾을 수 없습니다."),
    (
        "exit approval draft requires HQ confirmation first",
        "결재 초안을 만들려면 먼저 본사 확인이 필요합니다.",
    ),
    (
        "HR confirmation requires a REPORTED exit case",
        "인사 확인은 보고된 퇴사 건에만 할 수 있습니다.",
    ),
    (
        "only an open exit case (REPORTED through APPROVAL_DRAFTED) can be rejected",
        "진행 중인 퇴사 건만 반려할 수 있습니다.",
    ),
    (
        "only a REPORTED or HR_CONFIRMED exit case can be cancelled",
        "본사 확인 전의 퇴사 건만 취소할 수 있습니다.",
    ),
    (
        "cancelling an exit case requires the reporter or HR confirmation capability",
        "퇴사 보고를 취소할 권한이 없습니다.",
    ),
    ("reason is required", "사유(reason)가 필요합니다."),
    (
        "employee is already EXITED; no exit case can be reported",
        "이미 퇴사한 직원은 퇴사 보고를 할 수 없습니다.",
    ),
    (
        "employee is no longer EXITED; the exit cannot be reversed",
        "직원이 퇴사 상태가 아니어서 퇴사를 되돌릴 수 없습니다.",
    ),
    (
        "exit settlement requires complete wage source fields before approval draft",
        "결재 초안 전에 퇴직 정산 임금 자료를 모두 입력해야 합니다.",
    ),
    (
        "HQ confirmation must be performed by a different actor than the HR confirmer",
        "본사 확인은 인사 확인자와 다른 사람이 해야 합니다.",
    ),
    (
        "HQ confirmation requires a prior HR confirmation",
        "본사 확인 전에 인사 확인이 필요합니다.",
    ),
    (
        "the ops account confirming its own HR confirmation needs a passkey step-up",
        "운영 계정이 직접 인사 확인한 건을 본사 확인하려면 패스키로 본인 확인을 해야 합니다.",
    ),
    (
        "the passkey step-up did not verify",
        "본인 패스키 확인에 실패했습니다.",
    ),
    (
        "passkey step-up is not configured",
        "패스키 본인 확인을 사용할 수 없습니다.",
    ),
    (
        "HQ confirmation requires a recorded HR confirmer",
        "본사 확인에는 기록된 인사 확인자가 필요합니다.",
    ),
    (
        "HQ confirmation requires the exit-case HQ confirmation capability",
        "본사 확인 권한이 없습니다.",
    ),
    (
        "HR confirmation requires the exit-case HR confirmation capability",
        "인사 확인 권한이 없습니다.",
    ),
    (
        "rejecting an exit case requires an exit-case confirmation capability",
        "퇴사 건을 반려할 권한이 없습니다.",
    ),
    (
        "absence alert not found for employee",
        "해당 직원의 결근 알림을 찾을 수 없습니다.",
    ),
    (
        "employee or absence alert was not found in the requested branch",
        "요청한 지점에서 직원 또는 결근 알림을 찾을 수 없습니다.",
    ),
];
