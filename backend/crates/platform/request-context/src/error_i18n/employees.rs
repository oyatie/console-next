//! [`super::korean_message`] exact messages, part: Employees, lifecycle events and bulk appointment.

/// Exact English message → Korean (합니다체).
pub(super) const MESSAGES: &[(&str, &str)] = &[
    // Employees / lifecycle events
    ("employee not found", "직원을 찾을 수 없습니다."),
    (
        "employee was not found in this organization",
        "이 회사에서 직원을 찾을 수 없습니다.",
    ),
    ("comment is required", "사유(comment)가 필요합니다."),
    (
        "effective_date is required",
        "발효일(effective_date)이 필요합니다.",
    ),
    (
        "date must use YYYY-MM-DD",
        "날짜는 YYYY-MM-DD 형식이어야 합니다.",
    ),
    (
        "event_type must be ONBOARD, TRANSFER, PROMOTE, LEAVE_OF_ABSENCE, RETURN_FROM_LEAVE, or CONTRACT_RENEWAL",
        "지원하지 않는 인사 이벤트 유형입니다.",
    ),
    (
        "to_status must be ACTIVE, ON_LEAVE, or UNKNOWN",
        "변경 후 상태는 ACTIVE, ON_LEAVE, UNKNOWN 중 하나여야 합니다.",
    ),
    (
        "to_position is required for PROMOTE",
        "승진에는 새 직위(to_position)가 필요합니다.",
    ),
    (
        "expected_return_date is only allowed for LEAVE_OF_ABSENCE",
        "복귀 예정일은 휴직에만 입력할 수 있습니다.",
    ),
    (
        "contract_end_date is required for CONTRACT_RENEWAL",
        "계약 갱신에는 계약 종료일(contract_end_date)이 필요합니다.",
    ),
    (
        "contract_end_date is only allowed for CONTRACT_RENEWAL",
        "계약 종료일은 계약 갱신에만 입력할 수 있습니다.",
    ),
    (
        "expected_return_date must be on or after effective_date",
        "복귀 예정일은 발효일 이후여야 합니다.",
    ),
    (
        "contract_end_date must be on or after effective_date",
        "계약 종료일은 발효일 이후여야 합니다.",
    ),
    (
        "employee is already EXITED; no lifecycle events are allowed",
        "이미 퇴사한 직원에게는 인사 이벤트를 기록할 수 없습니다.",
    ),
    (
        "employee is ON_LEAVE; record RETURN_FROM_LEAVE first",
        "휴직 중인 직원입니다. 먼저 복직을 기록해 주십시오.",
    ),
    (
        "ONBOARD must result in ACTIVE status",
        "입사는 재직(ACTIVE) 상태가 되어야 합니다.",
    ),
    (
        "OFFBOARD and TERMINATE must result in EXITED status",
        "퇴사·해고는 퇴사(EXITED) 상태가 되어야 합니다.",
    ),
    (
        "OFFBOARD and TERMINATE are recorded by confirming an exit case",
        "퇴사·해고는 퇴사 건을 확인해야 기록됩니다.",
    ),
    (
        "TRANSFER must keep the employee ACTIVE",
        "전보 후에도 재직(ACTIVE) 상태여야 합니다.",
    ),
    (
        "PROMOTE must keep the employee ACTIVE",
        "승진 후에도 재직(ACTIVE) 상태여야 합니다.",
    ),
    (
        "LEAVE_OF_ABSENCE requires an ACTIVE employee",
        "재직 중인 직원만 휴직할 수 있습니다.",
    ),
    (
        "LEAVE_OF_ABSENCE must result in ON_LEAVE status",
        "휴직은 휴직(ON_LEAVE) 상태가 되어야 합니다.",
    ),
    (
        "RETURN_FROM_LEAVE requires an ON_LEAVE employee",
        "휴직 중인 직원만 복직할 수 있습니다.",
    ),
    (
        "RETURN_FROM_LEAVE must result in ACTIVE status",
        "복직은 재직(ACTIVE) 상태가 되어야 합니다.",
    ),
    (
        "CONTRACT_RENEWAL requires a CONTRACT employment",
        "계약직 직원만 계약을 갱신할 수 있습니다.",
    ),
    (
        "CONTRACT_RENEWAL must keep the current status",
        "계약 갱신은 현재 상태를 유지해야 합니다.",
    ),
    (
        "ONBOARD cannot be scheduled; effective_date must not be in the future (KST)",
        "입사는 예약할 수 없습니다. 발효일은 오늘(KST) 이전이어야 합니다.",
    ),
    (
        "lifecycle event not found",
        "인사 이벤트를 찾을 수 없습니다.",
    ),
    (
        "only a SCHEDULED lifecycle event can be cancelled",
        "효력 예정인 인사 이벤트만 취소할 수 있습니다.",
    ),
    (
        "a scheduled exit is withdrawn by cancelling or rejecting its exit case",
        "예정된 퇴사는 해당 퇴사 건을 취소하거나 반려해야 철회됩니다.",
    ),
    (
        "employee already has a scheduled exit; no exit case can be reported",
        "이미 퇴사가 예약된 직원은 퇴사 보고를 할 수 없습니다.",
    ),
    (
        "the exit has not taken effect; submit the settlement once the employee has exited",
        "퇴사가 아직 반영되지 않았습니다. 퇴사가 반영된 뒤 정산을 상신해 주십시오.",
    ),
    (
        "reason must be 1000 characters or fewer",
        "사유는 1000자 이하여야 합니다.",
    ),
    (
        "leave_type is only allowed for LEAVE_OF_ABSENCE",
        "휴직 유형은 휴직에만 입력할 수 있습니다.",
    ),
    (
        "leave_type must be CHILDCARE, MATERNITY, ILLNESS, PERSONAL, or OTHER",
        "휴직 유형은 육아, 출산, 질병, 개인 사유, 기타 중 하나여야 합니다.",
    ),
    ("hire_date is required", "입사일(hire_date)이 필요합니다."),
    (
        "hire_date must not be in the future (KST)",
        "입사일은 오늘(KST) 이전이어야 합니다.",
    ),
    (
        "contract_end_date is required for CONTRACT employment",
        "계약직은 계약 종료일(contract_end_date)이 필요합니다.",
    ),
    (
        "contract_start_date and contract_end_date are only allowed for CONTRACT employment",
        "계약 기간은 계약직에만 입력할 수 있습니다.",
    ),
    (
        "contract_end_date must be on or after contract_start_date",
        "계약 종료일은 계약 시작일 이후여야 합니다.",
    ),
    (
        "status must be ACTIVE, ON_LEAVE, EXITED, or UNKNOWN",
        "상태는 ACTIVE, ON_LEAVE, EXITED, UNKNOWN 중 하나여야 합니다.",
    ),
    // Bulk appointment
    (
        "bulk event_type must be TRANSFER or PROMOTE",
        "일괄 발령은 전보 또는 승진만 할 수 있습니다.",
    ),
    (
        "to_org_unit_id is required for TRANSFER",
        "전보에는 대상 조직(to_org_unit_id)이 필요합니다.",
    ),
    (
        "to_position is only allowed for PROMOTE",
        "새 직위는 승진에만 입력할 수 있습니다.",
    ),
    (
        "to_org_unit_id is only allowed for TRANSFER",
        "대상 조직은 전보에만 입력할 수 있습니다.",
    ),
    (
        "employee_ids must list 1 to 500 employees",
        "직원은 1명 이상 500명 이하로 선택해야 합니다.",
    ),
    (
        "employee_ids must not repeat an employee",
        "같은 직원을 두 번 선택할 수 없습니다.",
    ),
    // --- lane: PEOPLE-READS-2 --- roster paging, history paging, bulk targets, register export
    (
        "sort must be name, employee_number, hire_date or org_unit, optionally prefixed with -",
        "정렬 기준은 이름, 사번, 입사일, 소속 중 하나여야 합니다.",
    ),
    (
        "cursor is not a cursor this list returned for this sort",
        "목록 위치 정보가 올바르지 않습니다. 목록을 처음부터 다시 불러와 주십시오.",
    ),
    (
        "cursor and offset cannot be combined",
        "목록 위치 정보와 offset은 함께 쓸 수 없습니다.",
    ),
    (
        "cursor is not a cursor this history returned",
        "이력 위치 정보가 올바르지 않습니다. 이력을 처음부터 다시 불러와 주십시오.",
    ),
    (
        "lines must list 1 to 500 employees",
        "행별 발령은 1명 이상 500명 이하로 입력해야 합니다.",
    ),
    (
        "lines must not repeat an employee",
        "같은 직원을 두 번 입력할 수 없습니다.",
    ),
    (
        "a selection must name 1 to 3000 employees",
        "조건으로 선택한 직원은 1명 이상 3,000명 이하여야 합니다.",
    ),
    (
        "name the employees with exactly one of employee_ids, lines or selection",
        "대상 직원은 직접 선택, 행별 입력, 조건 선택 중 한 가지로만 지정해야 합니다.",
    ),
    (
        "lines are only allowed for TRANSFER",
        "행별 발령은 전보에만 쓸 수 있습니다.",
    ),
    (
        "to_org_unit_id is given per line when lines are used",
        "행별 발령에서는 대상 조직을 행마다 입력합니다.",
    ),
    (
        "layout must be standard or register",
        "내려받기 형식은 standard 또는 register만 쓸 수 있습니다.",
    ),
    // --- lane: EMP-FACTS --- 근로자 명부 items (MR-23)
    (
        "sex must be MALE or FEMALE",
        "성별은 남(MALE) 또는 여(FEMALE)로 입력해야 합니다.",
    ),
    (
        "exit_reason must be an exit_reason catalog code",
        "퇴직 사유는 퇴직 사유 목록의 코드여야 합니다.",
    ),
    (
        "an exit reason is recorded only for an exited employee",
        "퇴직 사유는 퇴직한 직원에게만 기록할 수 있습니다.",
    ),
    (
        "this exit was reported through an exit case; its reason is recorded there",
        "퇴직 처리로 신고된 퇴직입니다. 퇴직 사유는 퇴직 처리에서 기록합니다.",
    ),
    (
        "address is incomplete or invalid",
        "주소가 빠졌거나 올바르지 않습니다. 표시된 항목을 확인해 주십시오.",
    ),
    (
        "changes.address must be an address object",
        "주소는 주소 항목으로 입력해야 합니다.",
    ),
    (
        "changes.careers must be a list of careers",
        "경력은 경력 목록으로 입력해야 합니다.",
    ),
    (
        "career months must use YYYY-MM",
        "경력 기간은 YYYY-MM 형식이어야 합니다.",
    ),
    (
        "to must not be before from",
        "경력 종료 월은 시작 월보다 앞설 수 없습니다.",
    ),
    (
        "careers holds at most 100 rows",
        "경력은 100건까지 입력할 수 있습니다.",
    ),
    (
        "rows must hold 1 to 500 employees",
        "한 번에 1명 이상 500명 이하만 반영할 수 있습니다.",
    ),
];
