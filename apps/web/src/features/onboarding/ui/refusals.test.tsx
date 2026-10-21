import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../api";
import { loadCatalog } from "@console/i18n";
import { CommandError } from "../../../lib/react/command-error";
import { onboardingError } from "../present";

beforeAll(() => loadCatalog("ko"));

test.each([
  ["terms_text_changed", "새 내용을 읽고 동의"],
  ["terms_version_already_accepted", "미리보기로 돌아가"],
  ["terms_not_published", "운영사에 문의"],
  ["step_already_skipped", "운영 준비를 다시 확인"],
  ["step_not_skippable", "필요한 항목을 먼저 등록"],
  ["phase_not_setup", "해당 기록에서 변경"],
  ["preview_stale", "바뀐 항목을 다시 확인"],
  ["go_live_blocked", "할 일과 패스키 확인"],
])("%s states the refusal and its remedy without mutating the command", (code, remedy) => {
  const error = new ApiError(409, code, code);
  const before = { code: error.code, details: error.details };
  const html = renderToStaticMarkup(<CommandError error={error} own={onboardingError} />);
  expect(html).toContain('role="alert"');
  expect(html).toContain(remedy);
  expect({ code: error.code, details: error.details }).toEqual(before);
});
