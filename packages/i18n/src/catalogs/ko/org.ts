// Korean source for `org.` ids. Rules: the header of ../ko.ts and packages/i18n/GUIDE.md.
export const koOrg = {
  // Org: branches and regions
  "org.title": "조직",

  // Org: proposal form

  // Org: units
  "org.unit.picker.label": "소속 조직",
  "org.unit.picker.search": "조직 이름 검색",
  "org.unit.picker.open": "조직 목록 열기",

  // Org: change page
  "org.change.step.DRAFT": "초안",
  "org.change.step.PRECHECKED": "사전 점검",
  "org.change.step.IN_APPROVAL": "결재",
  "org.change.step.APPROVED": "승인",
  "org.change.step.APPLIED": "시행",
  "org.change.step.SETTLING": "정리",
  "org.change.step.ARCHIVED": "종결",
  "org.change.op.CREATE_REGION": "권역 신설 — {name}",
  "org.change.op.RENAME_REGION": "권역 이름 변경 — {region} → {name}",
  "org.change.op.DEACTIVATE_REGION": "권역 폐쇄 — {region}",
  "org.change.op.CREATE_BRANCH": "지점 신설 — {region} / {name}",
  "org.change.op.RENAME_BRANCH": "지점 변경 — {branch}",
  "org.change.op.RENAME_BRANCH.name": "지점 변경 — {branch} → {name}",
  "org.change.op.RENAME_BRANCH.region": "지점 변경 — {branch} ({region})",
  "org.change.op.RENAME_BRANCH.both": "지점 변경 — {branch} → {name} ({region})",
  "org.change.op.DEACTIVATE_BRANCH": "지점 폐쇄 — {branch}",
  "org.change.op.CREATE_SITE": "사업장 신설 — {name}",
  "org.change.op.UPDATE_SITE": "사업장 변경 — {name}",
  "org.change.op.REASSIGN_ORG_UNIT": "조직 재배치 — {from} → {to}",
  "org.change.op.CREATE_ORG_UNIT": "{kind} 신설 — {parent} / {name}",
  "org.change.op.RENAME_ORG_UNIT": "조직 이름 변경 — {unit} → {name}",
  "org.change.op.MOVE_ORG_UNIT": "조직 이동 — {unit} → {parent} 아래",
  "org.change.op.DISSOLVE_ORG_UNIT": "조직 폐지 — {unit}",
  "org.change.preflight": "사전 점검",
  "org.change.preflight.clear": "차단 없음",
  "org.change.approvals.drafterCannot": "기안자는 결재할 수 없습니다.",
  "org.change.decide.memoHint": "반려하려면 의견을 입력하십시오.",
  "org.change.decide.reject": "{role} 결재 반려",
  "org.change.decide.approve": "{role} 결재 승인",
  "org.change.decided.APPROVED": "{role} 결재를 승인했습니다",
  "org.change.effectuate": "조직 변경 시행",
  "org.change.submit.consequence": "{code} 조직 변경을 상신합니다. 상신한 뒤에는 내용을 수정할 수 없고, 결재선의 각 단계를 결재하면 시행일에 반영합니다.",
  "org.change.effectuate.apply": "{code} 조직 변경을 시행하면 조직에 즉시 반영됩니다. 되돌리려면 새 조직 변경을 상신해야 합니다.",
  "org.change.effectuate.reassign": "{code} 조직 개편을 시행하면 {from} 소속 직원 {count, plural, other {#명}}(휴직자 포함)을 {to|으로로} 지금 전보합니다. 휴직 등 각자의 상태는 그대로 유지됩니다. 되돌릴 수 없고 한 명씩 인사 이력과 감사 기록에 남습니다.",
  "org.change.rejected.next": "반려된 변경은 다시 상신할 수 없습니다. 의견을 반영해 조직 화면에서 새 변경을 상신하십시오.",
} as const;
