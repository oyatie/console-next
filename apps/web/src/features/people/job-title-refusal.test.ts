// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { ApiError } from "@console/api";
import { i18n, isMessageId, loadCatalog, t } from "@console/i18n";
import { failureText, readFailureText } from "../../lib/refusal";

for (const locale of ["ko", "en"] as const) {
  test.each(["job_title_label_invalid", "job_title_label_taken", "job_title_rank_invalid"])("%s has actionable catalog copy in " + locale, async code => {
    await loadCatalog(locale);
    i18n.set(locale);
    try {
      const key = `common.failed.code.${code}`;
      expect(isMessageId(key)).toBe(true);
      if (!isMessageId(key)) throw new Error(key);
      const text = t(key);
      expect(text.trim()).not.toBe("");
      expect(text).not.toBe(key);
      const error = new ApiError(code.endsWith("invalid") ? 422 : 409, code, "internal basis", [], undefined, true);
      expect(failureText(error)).toBe(text);
      expect(readFailureText(error)).toBe(text);
    } finally { i18n.set("ko"); }
  });
}
