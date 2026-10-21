// Gallery copy for the 회사 구조 bulk paths, history and conflict states (fe/cs-bulk-history). Dev-only, like
// gallery.ts, which spreads it.
export const orgBulkKitKo = {
  "section.orgPaste": "조직 구조 · 목록 붙여넣기",
  "section.orgHistory": "조직 구조 · 기준일과 충돌",
  "orgBulk.entity": "(주)새온바이오",
  "orgBulk.outline": "오송 본사\n\t경영지원팀\n\t연구개발본부\n\t\t원료연구팀\n청주공장\t공장\n\t생산부\n\t품질팀\n\t품질팀\n\t\t\t\t포장파트",
  "orgBulk.main": "오송 본사",
  "orgBulk.site": "청주공장",
  "orgBulk.dept": "경영지원팀",
  "stale.name": "생산관리팀",
  "stale.entity": "(주)새온정밀",
  "stale.site": "평택공장",
  "stale.parent": "생산부",
  "stale.from": "평택공장 바로 아래",
  "stale.to": "아산공장 › 생산부",
} as const;

export const orgBulkKitEn: Record<keyof typeof orgBulkKitKo, string> = {
  "section.orgPaste": "Org structure · paste a list",
  "section.orgHistory": "Org structure · as-of date and conflicts",
  "orgBulk.entity": "Saeon Bio Co., Ltd.",
  "orgBulk.outline": "Osong HQ\n\tManagement Support\n\tR&D Division\n\t\tMaterials Research\nOsong Plant\tPlant\n\tAssembly Division\n\tQuality\n\tQuality\n\t\t\t\tPacking",
  "orgBulk.main": "Osong HQ",
  "orgBulk.site": "Osong Plant",
  "orgBulk.dept": "Management Support",
  "stale.name": "Production Control",
  "stale.entity": "Saeon Precision Co., Ltd.",
  "stale.site": "Pyeongtaek Plant",
  "stale.parent": "Assembly Division",
  "stale.from": "directly under Pyeongtaek Plant",
  "stale.to": "Asan Plant › Assembly Division",
};
