// Korean source for `uiServerPicker.` ids (ui/server-picker). Rules: the header of ../ko.ts and GUIDE.md.
// No results is never a dead end: 「목록에 추가」 with permission, 「추가 요청」 without.
export const koUiServerPicker = {
  "uiServerPicker.name": "검색 선택기",
  "uiServerPicker.loading": "찾는 중",
  "uiServerPicker.count": "{count, plural, other {#건}}",
  "uiServerPicker.narrow": "처음 {count, number}건만 표시합니다. 검색어를 더 입력해 범위를 좁히십시오.",
  "uiServerPicker.none": "일치하는 결과가 없습니다",
  "uiServerPicker.keys": "동명이인은 사번·소속·로그인 식별 정보·계정 생성 시각으로 구분합니다",
  "uiServerPicker.homonym": "이름이 같은 사람이 {count}명입니다. 선택한 사람의 사번 끝 {digits}자리를 입력하십시오",
  "uiServerPicker.homonym.echo": "일치하면 선택됩니다: {name} ({code})",
  "uiServerPicker.escape.add": "「{query}」 목록에 추가",
  "uiServerPicker.escape.request": "「{query}」 추가 요청",
} as const;
