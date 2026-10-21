// Korean source for `live.` ids (connection, change notices, presence, leases). Rules: the header of
// ../ko.ts and packages/i18n/GUIDE.md. `*.hidden` variants drop the actor: a covert-labelled actor is
// never named (OD-RT-3). `{time}` and `{ago}` come preformatted from the shared formatters.
export const koLive = {
  // Connection (shell) and freshness (per screen)
  "live.status.reconnecting": "실시간 연결 끊김 · 재연결 중",
  "live.status.offline": "오프라인 · 화면이 자동으로 갱신되지 않음",
  "live.updated_ago": "{ago} 갱신",
  // Change notices on records and decision cards
  "live.notice.updated_by": "{actor}님이 {time}에 변경했습니다",
  "live.notice.updated_by.hidden": "{time}에 바뀌었습니다",
  "live.notice.changed_elsewhere": "보고 있는 기록이 {time}에 다른 곳에서 바뀌어 새 내용으로 표시합니다. 작성 중인 내용은 그대로입니다.",
  "live.notice.dismiss": "알림 닫기",
  "live.notice.changed_while_editing": "편집하는 동안 {count, plural, other {#개}} 항목이 바뀌었습니다. 작성 중인 내용은 그대로 남아 있습니다.",
  "live.notice.compare": "바뀐 항목 비교",
  "live.notice.content_changed": "검토하는 동안 내용이 바뀌었습니다. 새 내용을 확인해야 결재할 수 있습니다.",
  "live.notice.content_changed.open": "새 내용 보기",
  "live.notice.done_elsewhere": "{actor}님이 {time}에 이미 처리했습니다",
  "live.notice.done_elsewhere.hidden": "{time}에 이미 처리되었습니다",
  "live.notice.stacked": "{count, plural, other {#건}} 변경 · 마지막 변경 {actor}님",
  "live.notice.stacked.hidden": "{count, plural, other {#건}} 변경",
  "live.notice.gone": "이 항목이 삭제되어 더 이상 없습니다. 작성 중인 내용은 읽고 복사할 수 있습니다.",
  "live.notice.no_access": "이 항목을 볼 권한이 없어졌습니다. 작성 중인 내용은 읽고 복사할 수 있습니다.",
  // Lists (keyset paging with a pinned as_of)
  "live.list.new_rows": "새 항목 {count, plural, other {#건}} · 새로 고침",
  // Presence (advisory)
  "live.presence.viewing": "{name}님이 보는 중",
  "live.presence.editing": "{name}님이 수정 중",
  "live.presence.editing.field": "{name}님이 {field|을를} 수정 중",
  // Leases on queue items
  "live.claim.held_by": "{holder}님 처리 중 · {minutes, plural, other {#분}} 남음",
  "live.claim.take_over": "작업 가져오기",
  "live.claim.taken_over": "{actor}님이 이 작업을 가져갔습니다",
} as const;
