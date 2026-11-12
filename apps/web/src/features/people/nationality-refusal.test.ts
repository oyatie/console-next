// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { ApiError } from "@console/api";
import { i18n, isMessageId, loadCatalog, t } from "@console/i18n";
import { failureText } from "../../lib/refusal";

for (const locale of ["ko", "en"] as const) {
  test(`nationality_unknown has actionable catalog copy in ${locale}`, async () => {
    await loadCatalog(locale);
    i18n.set(locale);
    try {
      const key = "common.failed.code.nationality_unknown";
      expect(isMessageId(key)).toBe(true);
      if (!isMessageId(key)) throw new Error(key);
      expect(failureText(new ApiError(422, "nationality_unknown", "internal basis"))).toBe(t(key));
      expect(t(key)).toContain("GB");
    } finally { i18n.set("ko"); }
  });
}
