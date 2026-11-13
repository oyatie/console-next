// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test } from "vitest";
import { i18n, loadCatalog, t } from "@console/i18n";
import { decisionRefusalText } from "./present";

afterEach(() => i18n.set("ko"));

test.each(["ko", "en"] as const)("read and command refusals share the unavailable message in %s", async locale => {
  await loadCatalog(locale);
  i18n.set(locale);
  expect(decisionRefusalText("approval_decision_unavailable")).toBe(t("approvals.viewer.unavailable"));
  expect(decisionRefusalText("future_refusal")).toBe(t("approvals.viewer.blockedHint"));
});
