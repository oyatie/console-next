// Korean copy for `denied.` ids: the one refused state every screen shares (people-self-38, governance-18,
// worst-case-44). Rules: the header of ../ko.ts and GUIDE.md.
import type { enDenied } from "../en/denied";
export const koDenied: Record<keyof typeof enDenied, string> = {
  "denied.action.bulk_appointment": "「인사기본 · 등록·수정 · 전체」 또는 「발령 · 등록·수정 · 전체」",
  "denied.action.certificate_settings_manage": "번호·직인 설정 관리",
  "denied.scopeKind.LEGAL_ENTITY": "법인 범위",
  "denied.scopeKind.WORKPLACE": "사업장 범위",
  "denied.scopeKind.DEPARTMENT": "부서 범위",
  "denied.entity.deleted.reason": "이 법인은 방금 삭제되어 조회하거나 수정할 수 없습니다. 기록은 남아 있습니다.",
  "denied.entity.back": "법인 목록으로",
};