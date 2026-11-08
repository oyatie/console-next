// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { kindName } from "./present";

vi.mock("../../lib/labels", () => { throw new Error("Workplace labels must not load the enum registry"); });

beforeAll(() => loadCatalog("ko"));

test("workplace names use tenant labels and catalog fallbacks without loading the enum registry", () => {
  expect(kindName([{ code: "HEAD_OFFICE", label: "서울 사무소", platform: false, active: true }], "HEAD_OFFICE")).toBe("서울 사무소");
  expect(kindName(undefined, "HEAD_OFFICE")).toBe(t("workplace.kind.HEAD_OFFICE"));
  expect(kindName(undefined, "CUSTOM_WORKPLACE")).toBe("CUSTOM_WORKPLACE");
});
