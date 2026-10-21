// Korean source for `importJob.` ids (features/import/ui/job-step.tsx): the apply running as a job (r3:hire-02).
export const koImportJob = {
  "importJob.title": "명부 반영 중",
  "importJob.state.queued": "반영을 시작합니다 · 모의 반영에서 승인한 내용 그대로 씁니다",
  "importJob.state.applying": "직원을 명부에 넣는 중입니다",
  "importJob.state.settling": "배치와 고용 정보를 기록하는 중입니다",
  "importJob.rows": "{done}행 / {total}행",
  "importJob.leave": "이 화면을 떠나도 반영은 서버에서 끝까지 이어집니다. 가져오기로 돌아오면 여기서 이어 봅니다.",
  "importJob.toRoster": "직원 목록으로 (반영은 계속됩니다)",
  "importJob.failed": "반영하지 못했습니다",
  "importJob.back": "모의 반영으로 돌아가기",
  "importJob.error.rows_changed_since_preview": "모의 반영 뒤에 바뀐 직원이 있어 아무것도 쓰지 않았습니다. 모의 반영을 다시 실행하십시오.",
  "importJob.error.dry_run_digest_mismatch": "승인한 모의 반영이 이 가져오기의 마지막 모의 반영이 아니어서 아무것도 쓰지 않았습니다. 모의 반영을 다시 실행하십시오.",
  "importJob.error.apply_interrupted": "반영이 아무것도 쓰기 전에 멈췄습니다. 모의 반영으로 돌아가 다시 반영하십시오.",
  "importJob.error.other": "반영이 멈췄습니다. 모의 반영으로 돌아가 다시 실행하면 이미 들어간 행은 변경 없음으로 나옵니다.",
  "importJob.started": "명부 반영을 시작했습니다",
} as const;
