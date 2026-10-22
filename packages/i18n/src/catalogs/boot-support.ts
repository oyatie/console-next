// SPDX-License-Identifier: LicenseRef-Proprietary
export const bootSupportKo = {
  "common.supportReference.copy": "지원 참조 번호 복사",
  "common.supportReference.copied": "지원 참조 번호를 복사했습니다",
  "common.supportReference.copyFailed": "복사하지 못했습니다. 지원 참조 번호를 선택해 직접 복사하십시오.",
  "common.supportReference": "지원 참조 번호",
} as const;

export const bootSupportEn: Record<keyof typeof bootSupportKo, string> = {
  "common.supportReference": "Support reference",
  "common.supportReference.copy": "Copy support reference",
  "common.supportReference.copied": "Support reference copied",
  "common.supportReference.copyFailed": "Could not copy. Select and copy the full support reference.",
};
