// SPDX-License-Identifier: LicenseRef-Proprietary
/* oxlint-disable react/jsx-no-literals -- Static component contract assertions use synthetic copy. */
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { SidePanel } from "./side-panel";

beforeAll(() => loadCatalog("ko"));

test("a peek keeps its named non-modal frame and slots, and renders nothing when closed", () => {
  const render = (open: boolean, loading = false) => renderToStaticMarkup(
    <SidePanel open={open} title="선택한 직원" crumb="소속" chips={<span>재직</span>} openLink={<a href="/people/test">열기</a>} onClose={() => {}} loading={loading}>
      <p>조회한 내용</p>
    </SidePanel>,
  );
  const html = render(true);
  expect(html).toContain("<aside");
  expect(html).toMatch(/aria-labelledby="[^"]+"/);
  expect(html).not.toContain("aria-modal");
  for (const text of ["선택한 직원", "소속", "재직", "열기", "상세 패널 닫기", "조회한 내용"]) expect(html).toContain(text);
  expect(render(false)).toBe("");
  const pending = render(true, true);
  expect(pending).toContain("선택한 직원");
  expect(pending).toContain('aria-busy="true"');
  expect(pending).not.toContain("조회한 내용");
});
