// SPDX-License-Identifier: LicenseRef-Proprietary
import type { enAccessCheck } from "../en/access-check";

export const koAccessCheck: Record<keyof typeof enAccessCheck, string> = {
  "accessCheck.title": "권한 확인",
  "accessCheck.subjectLabel": "확인 대상 계정 ID",
  "accessCheck.orgLabel": "조직 ID",
  "accessCheck.rolesLabel": "보유 역할 코드 (쉼표 구분)",
  "accessCheck.resourceType": "자원 유형",
  "accessCheck.resourceId": "자원 ID",
  "accessCheck.action": "확인 동작",
  "accessCheck.runSingle": "단건 권한 판정",
  "accessCheck.runBulk": "기본 동작 일괄 판정",
  "accessCheck.resultTitle": "판정 결과",
  "accessCheck.effect.allow": "허용",
  "accessCheck.effect.deny": "거부",
  "accessCheck.policies": "근거 정책",
};
