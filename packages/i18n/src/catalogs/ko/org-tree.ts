// Korean source for `orgTree.` ids (the org chart, the unit card and its actions). Rules: ../ko.ts header and GUIDE.md.
export const koOrgTree = {
  "orgTree.act.register": "{name}에 직원 등록",
  "orgTree.history.title": "이력 {count, plural, other {#건}}",
  "orgTree.history.created": "{date} 신설 · {name}",
  "orgTree.history.renamed": "{date} 이름 변경 · {from} → {to}",
  "orgTree.history.moved": "{date} 이동 · {from} → {to}",
  "orgTree.history.dissolved": "{date} 폐지",
  "orgTree.history.meta": "{actor}님 · {at}",
  "orgTree.history.code": "{date} 코드 변경 · {from} → {to}",
  "orgTree.history.head": "{date} 부서장 지정 · {from} → {to}",
  "orgTree.history.merged": "{date} 통합 · {into}에 통합되어 폐지(이력에 남음)",
  "orgTree.history.none": "없음",
  "orgTree.history.vacant": "공석",
} as const;
