// SPDX-License-Identifier: LicenseRef-Proprietary
// Korean source for `workplaceRegChange.` ids (the 사업장 사업자등록 change dialog; split from workplace.ts for the 300-line ceiling).
export const koWorkplaceRegChange = {
  "workplaceRegChange.action": "등록 변경",
  "workplaceRegChange.title": "{name} 사업자등록 변경",
  "workplaceRegChange.kicker": "{entity} · {name}",
  "workplaceRegChange.target": "변경할 사업자등록",
  "workplaceRegChange.from": "변경일",
  "workplaceRegChange.reason": "변경 사유",
  "workplaceRegChange.none": "등록증 연결 안 함",
  "workplaceRegChange.save": "등록 변경",
  "workplaceRegChange.saved": "{name}의 사업자등록을 변경했습니다",
  "workplaceRegChange.same": "지금 연결된 사업자등록과 같습니다. 다른 등록증이나 일련번호를 선택하십시오.",
  "workplaceRegChange.pickDate": "변경일을 입력하십시오.",
  "workplaceRegChange.consequence": "{name|은는} {date}부터 새 등록증으로 신고합니다.",
  "workplaceRegChange.unlinked": "{name|은는} {date}부터 사업자등록 연결을 해제합니다.",
} as const;
