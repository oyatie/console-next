// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { ApiError } from "@console/api";
import { isMessageId, loadCatalog, t } from "@console/i18n";
import { failureText, readFailureText } from "../../lib/refusal";

for (const locale of ["ko", "en"] as const) {
  test.each(["org_change_scheduled_content", "org_change_scheduled_locked"] as const)(`scheduled refusal %s has actionable ${locale} copy`, async code => {
    await loadCatalog(locale);
    const key = `common.failed.code.${code}` as const;
    expect(isMessageId(key)).toBe(true);
    const error = new ApiError(code === "org_change_scheduled_content" ? 409 : 403, code, "Untranslated server message");
    expect(failureText(error)).toBe(t(key));
    expect(readFailureText(error)).toBe(t(key));
    expect(failureText(error)).not.toContain(code);
  });
}
