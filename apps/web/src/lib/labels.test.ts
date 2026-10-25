// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { LEAVE_TYPE, actor, label, labeled } from "./labels";

beforeAll(() => loadCatalog("ko"));

test("unnamed actors retain a visible person label", () => {
  for (const name of ["", "   "]) expect(actor(name)).toBe("이름 미등록");
  expect(actor(" 박관리자 ")).toBe("박관리자");
  expect(actor(null)).toBe("—");
});

test("unknown leave types have a neutral label and a separate diagnostic code", () => {
  expect(label(LEAVE_TYPE, "FUTURE_LEAVE")).toBe("확인되지 않은 항목");
  expect(labeled(LEAVE_TYPE, "FUTURE_LEAVE")).toEqual({ label: "확인되지 않은 항목", tone: "neutral", code: "FUTURE_LEAVE" });
  expect(label(LEAVE_TYPE, "WORK_INJURY")).toBe("산재 요양");
});

test("known leave choices remain checked by TypeScript", () => {
  // @ts-expect-error A future response is readable, but a misspelled command choice is not valid.
  const typo: (typeof LEAVE_TYPE.values)[number] = "CHILDCAR";
  expect(LEAVE_TYPE.values).not.toContain(typo);
});
