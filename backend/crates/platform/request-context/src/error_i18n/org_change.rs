//! [`super::korean_message`] exact messages, part: Org change and org units.

/// Exact English message → Korean (합니다체).
pub(super) const MESSAGES: &[(&str, &str)] = &[
    // Org change / org units
    (
        "role is not allowed to read org changes",
        "조직 변경을 조회할 권한이 없습니다.",
    ),
    (
        "role is not allowed to draft org changes",
        "조직 변경을 기안할 권한이 없습니다.",
    ),
    (
        "role is not allowed to approve org changes",
        "조직 변경을 승인할 권한이 없습니다.",
    ),
    (
        "role is not allowed to apply org changes",
        "조직 변경을 적용할 권한이 없습니다.",
    ),
    (
        "token is not authorized for org changes",
        "이 토큰으로는 조직 변경을 할 수 없습니다.",
    ),
    (
        "org-change request was not found",
        "조직 변경 요청을 찾을 수 없습니다.",
    ),
    (
        "superseded org-change request was not found",
        "대체할 조직 변경 요청을 찾을 수 없습니다.",
    ),
    (
        "only a REJECTED request can be superseded by a revision",
        "반려된 요청만 수정안으로 대체할 수 있습니다.",
    ),
    (
        "effectiveDate must be today or later (KST)",
        "발효일은 오늘(KST) 이후여야 합니다.",
    ),
    (
        "only a DRAFT or PRECHECKED request can be edited",
        "기안 또는 사전점검 상태의 요청만 수정할 수 있습니다.",
    ),
    (
        "preflight runs only on a DRAFT or PRECHECKED request",
        "사전점검은 기안 또는 사전점검 상태에서만 실행할 수 있습니다.",
    ),
    (
        "submit requires a DRAFT or PRECHECKED request",
        "기안 또는 사전점검 상태의 요청만 상신할 수 있습니다.",
    ),
    (
        "preflight blockers are present; resolve them and re-run preflight",
        "사전점검 차단 항목이 있습니다. 해소한 뒤 사전점검을 다시 실행해 주십시오.",
    ),
    (
        "approval decisions apply only while the request is IN_APPROVAL",
        "결재 진행 중인 요청에만 결재할 수 있습니다.",
    ),
    (
        "approval step is already decided",
        "이미 결재된 단계입니다.",
    ),
    (
        "approval step was not found",
        "결재 단계를 찾을 수 없습니다.",
    ),
    (
        "approval steps must be decided in order",
        "결재 단계는 순서대로 처리해야 합니다.",
    ),
    (
        "only an APPROVED request can be effectuated",
        "승인된 요청만 적용할 수 있습니다.",
    ),
    (
        "only a SETTLING request can be archived",
        "정산 중인 요청만 보관할 수 있습니다.",
    ),
    (
        "settlement items complete only while the request is SETTLING",
        "정산 항목은 정산 중인 요청에서만 완료할 수 있습니다.",
    ),
    (
        "settlement item is already complete",
        "이미 완료된 정산 항목입니다.",
    ),
    (
        "settlement item was not found",
        "정산 항목을 찾을 수 없습니다.",
    ),
    (
        "unsettled items remain; complete every settlement item first",
        "미완료 정산 항목이 있습니다. 모든 정산 항목을 먼저 완료해 주십시오.",
    ),
    (
        "illegal org-change status transition",
        "허용되지 않는 조직 변경 상태 전환입니다.",
    ),
    (
        "legacy org-setup proposals must contain exactly one operation",
        "조직 설정 기안에는 작업이 정확히 하나여야 합니다.",
    ),
    (
        "legacy org-setup proposals only accept region or branch operations",
        "조직 설정 기안은 지역 또는 지점 작업만 받을 수 있습니다.",
    ),
    (
        "name and/or parentId is required",
        "이름 또는 상위 조직이 필요합니다.",
    ),
    (
        "MOVE_ORG_UNIT parentId must differ from orgUnitId",
        "조직 이동 시 상위 조직은 대상 조직과 달라야 합니다.",
    ),
    (
        "REASSIGN_ORG_UNIT source and target must differ",
        "재배치 원본 조직과 대상 조직은 달라야 합니다.",
    ),
    (
        "REASSIGN_ORG_UNIT fromOrgUnit/toOrgUnit must be OrgUnit UUIDs",
        "재배치 조직은 조직 ID로 지정해야 합니다.",
    ),
    (
        "RENAME_BRANCH requires a name and/or a target region",
        "지점 변경에는 이름 또는 대상 지역이 필요합니다.",
    ),
    (
        "target.ref must be a UUID for REGION/BRANCH/SITE targets",
        "지역·지점·사업장 대상은 ID로 지정해야 합니다.",
    ),
    ("org unit was not found", "조직을 찾을 수 없습니다."),
    (
        "org unit was not found in this organization",
        "이 회사에서 조직을 찾을 수 없습니다.",
    ),
    ("org unit is not active", "활성 상태의 조직이 아닙니다."),
    (
        "parent org unit is not active",
        "상위 조직이 활성 상태가 아닙니다.",
    ),
    (
        "org unit kind cannot nest under that parent",
        "이 조직 유형은 해당 상위 조직 아래에 둘 수 없습니다.",
    ),
    (
        "active child org units remain",
        "활성 하위 조직이 남아 있습니다.",
    ),
    (
        "employees (on leave included) remain in the org unit",
        "조직에 휴직자를 포함한 직원이 남아 있습니다. 먼저 다른 조직으로 옮겨야 합니다.",
    ),
    (
        "active branches remain under the region",
        "지역에 활성 지점이 남아 있습니다.",
    ),
    (
        "active users are still assigned to the branch",
        "지점에 배정된 활성 사용자가 남아 있습니다.",
    ),
    (
        "non-terminal equipment remains in the branch",
        "지점에 처리되지 않은 장비가 남아 있습니다.",
    ),
    ("region was not found", "지역을 찾을 수 없습니다."),
    ("region not found", "지역을 찾을 수 없습니다."),
    (
        "region is already deactivated",
        "이미 비활성화된 지역입니다.",
    ),
    ("branch was not found", "지점을 찾을 수 없습니다."),
    ("branch not found", "지점을 찾을 수 없습니다."),
    (
        "branch is already deactivated",
        "이미 비활성화된 지점입니다.",
    ),
    ("site was not found", "사업장을 찾을 수 없습니다."),
    ("unknown status filter", "알 수 없는 상태 필터입니다."),
    ("unknown kind filter", "알 수 없는 유형 필터입니다."),
    (
        "request body is not canonical",
        "요청 본문 형식이 올바르지 않습니다.",
    ),
    (
        "org_unit_id is required",
        "소속 조직(org_unit_id)이 필요합니다.",
    ),
    (
        "org_unit_id must be an ACTIVE site, department, or team",
        "소속 조직은 활성 상태의 사업장·부서·팀이어야 합니다.",
    ),
];
