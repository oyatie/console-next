// SPDX-License-Identifier: LicenseRef-Proprietary
// Loading and recovery must remain readable before any locale chunk arrives.
import { bootSupportEn, bootSupportKo } from "./boot-support";
export const bootBootstrapEn = {
  ...bootSupportEn,
  "app.name": "Console",
  "app.title.brand": "Console",
  "common.loading": "Loading…",
  "common.notFound.title": "Page not found",
  "common.notFound.reason": "The address has changed or the page doesn’t exist. Start again from Home.",
  "common.notFound.action": "Go to Home",
  "common.crashed.title": "Couldn’t show this screen",
  "common.crashed.reason": "A new version may have been released, or this may be a temporary error. Reload the page.",
  "common.crashed.action": "Reload page",
};

export const bootBootstrapKo: Record<keyof typeof bootBootstrapEn, string> = {
  ...bootSupportKo,
  "app.name": "콘솔",
  "app.title.brand": "Console",
  "common.loading": "불러오는 중…",
  "common.notFound.title": "페이지를 찾을 수 없습니다",
  "common.notFound.reason": "주소가 바뀌었거나 없는 페이지입니다. 홈에서 다시 시작하십시오.",
  "common.notFound.action": "홈으로 이동",
  "common.crashed.title": "화면을 표시하지 못했습니다",
  "common.crashed.reason": "새 버전이 배포되었거나 일시적인 오류일 수 있습니다. 페이지를 새로 고치십시오.",
  "common.crashed.action": "페이지 새로 고침",
};
