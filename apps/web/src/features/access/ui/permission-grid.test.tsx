// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { AccessCatalogDomain } from "../api";
import { PermissionGrid } from "./permission-grid";

beforeAll(() => loadCatalog("ko"));
test("matrix cells are labelled checkboxes, including implied view, without a roadmap footnote", () => {
  const html = renderToStaticMarkup(<PermissionGrid domains={[
    { domain: "hr_basic", grantable: true, levels: ["view", "edit"], operations: [{ operation: "edit", level: "edit" }] },
    { domain: "pay", grantable: true, levels: ["view"], operations: [] },
  ]} value={{ hr_basic: ["edit"] }} routed={new Set()} onChange={() => {}} />);
  expect(html.match(/type="checkbox"/g)).toHaveLength(2);
  expect(html.match(/checked=""/g)).toHaveLength(2);
  expect(html).toContain(t("access.grid.auto"));
  expect(html).not.toContain("aria-pressed");
  expect(html).not.toContain("아직 없음");
  const labels = html.match(/<label class="check">.*?<\/label>/g)!;
  expect(labels.map(label => label.replace(/<[^>]*>/g, ""))).toEqual([t("access.grid.auto"), ""]);
});


test("pay grants explain inactivity outside the narrow table cell until payroll is ready", () => {
  const domains: AccessCatalogDomain[] = ["pay", "sensitive"].map((domain) => ({
    domain, grantable: true, levels: ["view", "edit"],
    operations: [{ operation: `${domain}::view`, level: "view" }, { operation: `${domain}::edit`, level: "edit" }],
  }));
  const inactive = "급여가 활성화되지 않아 급여·민감 급여 그룹 권한은 급여 화면에서 사용할 수 없습니다.";
  for (const payrollReady of [undefined, false, true]) {
    const html = renderToStaticMarkup(<PermissionGrid domains={domains} value={{}} routed={undefined} payrollReady={payrollReady} onChange={() => {}} />);
    const help = html.split("</table>")[0]!.match(/<small[^>]*>.*?<\/small>/g) ?? [];
    expect(help.some((slot) => slot.includes(inactive))).toBe(false);
    expect(html.includes(inactive)).toBe(!payrollReady);
    if (!payrollReady) expect(html.indexOf(inactive)).toBeGreaterThan(html.indexOf("</table>"));
    expect(html).toContain("민감 급여 그룹");
    expect(html).toContain(t("accessCodes.domain.sensitive.help"));
    expect(html).not.toMatch(/건강·민감|건강·장애|노조/);
    expect(html.match(/type="checkbox"/g)).toHaveLength(4);
    expect(html).not.toContain("aria-pressed");
  }
});

test("support approval is a server-catalogued authority with approval wording", () => {
  const html = renderToStaticMarkup(<PermissionGrid domains={[
    { domain: "vendor_support", grantable: true, levels: ["approve"], operations: [{ operation: "support_access::approve", level: "approve" }] },
    { domain: "hr_basic", grantable: true, levels: ["approve"], operations: [{ operation: "hr_basic::approve", level: "approve" }] },
  ]} value={{}} routed={undefined} onChange={() => {}} />);
  expect(html).toContain('aria-label="vendor_support 승인"');
  expect(html).toContain('aria-label="인사기본 결정"');
  expect(html.match(/type="checkbox"/g)).toHaveLength(2);
});
