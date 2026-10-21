// Korean source for `orgConflict.` ids (apps/web/src/features/org-bulk): what a refused or overtaken
// change on the org chart says (S11). Never a dead end: each state names its way on.
export const koOrgConflict = {
  "orgConflict.stale.title": "이동하지 않았습니다 · 다른 담당자가 먼저 변경했습니다",
  "orgConflict.stale.now": "{name|은는} 지금 {path} 아래에 있습니다. 조직도를 새로 그렸습니다.",
  "orgConflict.stale.gone": "{name|은는} 지금 조직도에 없습니다. 조직도를 새로 그렸습니다.",
  "orgConflict.stale.tried": "내가 하려던 것: {name|을를} {from}에서 {to} 아래로{members, plural, =-1 {} other { · 구성원 #명}}",
  "orgConflict.stale.retry": "지금 위치에서 다시 이동",
  "orgConflict.stale.leave": "그대로 유지",
  "orgConflict.stale.history": "변경 내역 보기",
} as const;
