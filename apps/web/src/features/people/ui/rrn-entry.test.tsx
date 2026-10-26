// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { FORMATS, complete, parseWith } from "../../../lib/pure/formats";
import { EMPTY } from "../domain/register";
import { RegisterPerson } from "./register-person";

beforeAll(() => loadCatalog("ko"));

test("RRN entry has thirteen digits, a separator, and no client checksum", () => {
  const format = FORMATS["rrn" as keyof typeof FORMATS];
  expect(format).toBeDefined();
  expect(format).not.toHaveProperty("warnings");
  expect(format.min).toBe(13);
  expect(format.max).toBe(13);
  expect(complete(format, "0".repeat(12))).toBe(false);
  expect(complete(format, "0".repeat(13))).toBe(true);
  expect(parseWith(format, "０".repeat(14))).toBe("0".repeat(13));
  expect(format.display("0".repeat(13))).toBe(`${"0".repeat(6)}-${"0".repeat(7)}`);
});

test("registration collects no RRN and makes no unserved promise", () => {
  const html = renderToStaticMarkup(<RegisterPerson d={EMPTY} set={() => {}} shown={new Set()} />);
  expect(html).not.toContain("주민등록번호");
  expect(html).not.toContain("법적 근거 확인 중");
});
