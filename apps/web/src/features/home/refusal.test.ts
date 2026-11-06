// SPDX-License-Identifier: LicenseRef-Proprietary
import { ApiError } from "@console/api";
import { i18n, loadCatalog } from "@console/i18n";
import { afterEach, expect, test } from "vitest";
import { failureText } from "../../lib/refusal";

afterEach(() => i18n.set("ko"));

test.each([
  ["change_request_closed", 409, "이미 처리되거나 철회된 요청입니다. 요청 목록에서 현재 상태를 확인하십시오.", "This request has already been decided or withdrawn. Check its current status in the request list."],
  ["change_request_self_decision", 422, "본인이 보낸 변경 요청은 직접 처리할 수 없습니다. 다른 담당자에게 처리를 요청하십시오.", "You cannot decide a change request you sent. Ask another handler to decide it."],
] as const)("%s uses actionable copy in both locales", async (code, status, ko, en) => {
  for (const [locale, expected] of [["ko", ko], ["en", en]] as const) {
    await loadCatalog(locale);
    i18n.set(locale);
    expect(failureText(new ApiError(status, code, "upstream diagnostic"))).toBe(expected);
  }
});
