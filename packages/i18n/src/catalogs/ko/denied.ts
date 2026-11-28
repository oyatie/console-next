// Korean copy for `denied.` ids: the one refused state every screen shares (people-self-38, governance-18,
// worst-case-44). Rules: the header of ../ko.ts and GUIDE.md.
import type { enDenied } from "../en/denied";
export const koDenied: Record<keyof typeof enDenied, string> = {
  "denied.capability.analytics_projection": "분석 예측 조회 권한이 필요합니다.",
  "denied.capability.lifecycle_manage": "조직 전체의 생애주기 관리 권한이 필요합니다.",
  "denied.capability.restricted_audit_stream": "제한 감사 기록 열람 권한이 필요합니다.",
  "denied.capability.served_evaluation_cycles": "평가 주기 조회 권한이 필요합니다.",
  "denied.capability.served_evaluation_cycle_create": "평가 주기 생성 권한이 필요합니다.",
  "denied.capability.served_evaluation_tasks": "평가 제출 권한이 필요합니다.",
  "denied.capability.served_calendar": "내부 일정 조회 권한이 필요합니다.",
  "denied.capability.documents": "조직 전체 증거 접근 권한이 필요합니다.",
  "denied.capability.served_integrity_findings": "무결성 검토 항목 조회 권한이 필요합니다.",
  "denied.capability.served_integrity_triage": "무결성 검토 항목 조회 권한이 필요합니다.",
  "denied.capability.served_location_consent_ledger": "선택한 지점의 감사 조회 권한이 필요합니다.",
  "denied.capability.served_benefit_catalog": "복리후생 항목 조회 권한이 필요합니다.",
  "denied.action.bulk_appointment": "「인사기본 · 등록·수정 · 전체」 또는 「발령 · 등록·수정 · 전체」",
  "denied.action.certificate_settings_manage": "번호·직인 설정 관리",
  "denied.scopeKind.LEGAL_ENTITY": "법인 범위",
  "denied.scopeKind.WORKPLACE": "사업장 범위",
  "denied.scopeKind.DEPARTMENT": "부서 범위",
  "denied.entity.deleted.reason": "이 법인은 방금 삭제되어 조회하거나 수정할 수 없습니다. 기록은 남아 있습니다.",
  "denied.entity.back": "법인 목록으로",
};