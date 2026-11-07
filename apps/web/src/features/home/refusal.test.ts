// SPDX-License-Identifier: LicenseRef-Proprietary
import { ApiError } from "@console/api";
import { i18n, loadCatalog } from "@console/i18n";
import { afterEach, expect, test } from "vitest";
import { failureText } from "../../lib/refusal";

afterEach(() => i18n.set("ko"));

test.each([
  ["change_request_closed", 409, "이미 처리되거나 철회된 요청입니다. 요청 목록에서 현재 상태를 확인하십시오.", "This request has already been decided or withdrawn. Check its current status in the request list."],
  ["change_request_self_decision", 422, "본인이 보낸 변경 요청은 직접 처리할 수 없습니다. 다른 담당자에게 처리를 요청하십시오.", "You cannot decide a change request you sent. Ask another handler to decide it."],
  ["change_request_not_assignee", 403, "이 요청의 담당자만 처리할 수 있습니다. 요청 목록에서 담당자를 확인하십시오.", "Only the assigned handler can decide this request. Check the assignee in the request list."],
  ["change_request_not_requester", 403, "본인이 보낸 요청만 철회할 수 있습니다. 요청 목록에서 요청자를 확인하십시오.", "You can only withdraw requests you sent. Check the requester in the request list."],
] as const)("%s uses actionable copy in both locales", async (code, status, ko, en) => {
  for (const [locale, expected] of [["ko", ko], ["en", en]] as const) {
    await loadCatalog(locale);
    i18n.set(locale);
    expect(failureText(new ApiError(status, code, "upstream diagnostic"))).toBe(expected);
  }
});
