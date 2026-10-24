// SPDX-License-Identifier: LicenseRef-Proprietary
// Screen-only refusal copy loads with the locale catalog, after sign-in.
export const koCommon = {
  "common.failed.code.site_needs_workplace": "사업장은 조직 변경으로 추가하지 않습니다. 법인 화면에서 사업장을 추가하십시오.",
  "common.failed.code.region_branch_retired": "권역과 지점은 더 이상 따로 추가하거나 변경하지 않습니다. 사업장을 추가하면 그 지점이 함께 생깁니다.",
  "common.failed.code.branch_backs_workplace": "이 지점은 사업장의 지점이라 따로 닫을 수 없습니다. 사업장을 폐쇄하면 함께 닫힙니다.",
  "common.failed.code.site_is_a_workplace": "사업장의 이름 변경·이동·삭제·폐쇄는 조직 변경이 아니라 법인의 사업장 화면에서 합니다.",
  "common.failed.code.workplace_kind_not_found": "그 사업장 종류가 없습니다. 목록을 다시 열어 선택하십시오.",
  "common.failed.code.children_changed": "그사이 다른 사람이 하위 목록을 변경했습니다. 다시 열어 순서를 정하십시오.",
  "common.failed.code.org_unit_has_members": "아직 퇴직하지 않은 직원이 이 부서나 그 아래에 있어 삭제하지 않았습니다. 직원을 먼저 다른 부서로 발령하십시오.",
  "common.failed.code.undo_conflict": "이 변경 뒤에 같은 조직이 또 바뀌어 되돌리지 않았습니다. 나중 변경부터 되돌리십시오.",
  "common.failed.code.undo_unit_in_use": "새로 추가한 부서에 그 뒤 직원이나 하위 부서가 들어와 되돌리지 않았습니다. 직원은 먼저 발령하고 하위 부서는 이동하십시오.",
  "common.failed.code.batch_not_undoable": "되돌리기는 다시 되돌릴 수 없습니다. 필요하면 같은 변경을 새로 하십시오.",
  "common.failed.code.batch_already_undone": "이미 되돌린 변경입니다.",
  "common.failed.code.org_setup_batch_not_found": "되돌릴 변경을 찾지 못했습니다. 화면을 다시 불러오십시오.",
  "common.failed.code.phase_not_setup": "운영이 시작되어 바로 변경할 수 없습니다. 조직 변경을 기안하십시오.",
  "common.failed.code.contract_overlap": "기존 계약과 기간이 겹칩니다. 계약 내역에서 겹치는 계약을 정정하십시오.",
  "common.failed.code.workplace_not_open_on_date": "배치일에는 사업장과 법인이 모두 개설되어 있어야 합니다. 개설일 이후 날짜를 선택하십시오.",
  "common.failed.code.rehire_date_not_after_exit": "재입사일은 마지막 퇴직일 다음 날부터 선택하십시오.",
  "common.failed.code.filing_applicability_unverified": "신고 적용 사실을 확인하지 않아 저장하지 않았습니다. 근로시간·국적 등 필요한 사실을 확인하고, 생년월일이 다르면 직원 기록에서 정정하십시오.",
  "common.failed.code.support_reference_cross_tenant_denied": "다른 고객 계정의 지원 참조 번호는 조회할 수 없습니다.",
  "common.failed.code.support_reference_grant_required": "지원 참조 번호를 조회할 권한이 없습니다. 관리자에게 권한을 요청하십시오.",
  "common.failed.code.support_reference_not_found": "지원 참조 번호를 찾지 못했습니다. 번호를 확인하십시오.",
} as const;
