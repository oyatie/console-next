// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { Composer } from "./composer";
import { commitLabel } from "./actions";

beforeAll(() => loadCatalog("ko"));

test("the composer orders populated preview sections and omits empty ones", () => {
  const fields = "fields";
  const html = renderToStaticMarkup(<Composer layout="page" title="전보" action={{ kind: "TRANSFER", mode: "apply", count: 2 }} onSubmit={() => {}} onClose={() => {}} sections={{ payroll: "pay", tasks: "tasks", effects: "effects", preflight: "checks", documents: null, access: "access", approvals: "route", deadlines: "due" }}>{fields}</Composer>);
  const headings = [...html.matchAll(/data-composer-section="([^"]+)"/g)].map((m) => m[1]);
  expect(headings).toEqual(["preflight", "effects", "approvals", "deadlines", "tasks", "access", "payroll"]);
  expect(html).toContain("전보 2명 반영");
  expect(html).toContain(">닫기</button>");
  expect(html.indexOf("fields")).toBeLessThan(html.indexOf('data-composer-section="preflight"'));
});

test("every preview section keeps the ideal's order and empty previews stay absent", () => {
  const render = (sections: Parameters<typeof Composer>[0]["sections"]) => renderToStaticMarkup(<Composer layout="page" title="review" action={{ kind: "orgChange", mode: "request" }} onSubmit={() => {}} sections={sections}>{null}</Composer>);
  const full = render({ payroll: "p", access: "a", tasks: "t", deadlines: "l", documents: "d", approvals: "r", effects: "e", preflight: "c" });
  expect([...full.matchAll(/data-composer-section="([^"]+)"/g)].map((m) => m[1])).toEqual(["preflight", "effects", "approvals", "documents", "deadlines", "tasks", "access", "payroll"]);
  expect(render({ preflight: false, effects: "", documents: [], approvals: null })).not.toContain("data-composer-section");
});

test("embedded composers use the caller's heading level and keep signoffs in preflight", () => {
  const html = renderToStaticMarkup(<Composer layout="inline" headingLevel={3} title="부서 정보" action={{ kind: "orgDetails", mode: "change" }} onSubmit={() => {}} signoffs={{ items: [{ id: "review", label: "Reviewed" }], value: [], onChange: () => {}, missing: false }}>{null}</Composer>);
  expect(html).not.toContain("<h1");
  expect(html.match(/<section[^>]*data-composer-root[^>]*>/)?.[0]).not.toContain("aria-labelledby");
  expect(html).toMatch(/<h3[^>]*>부서 정보<\/h3>/);
  expect(html).toMatch(/data-composer-section="preflight"[\s\S]*Reviewed/);
  expect(html).toContain("<h4");
});

test.each([
  [{ kind: "TRANSFER", mode: "apply", count: 2 }, "전보 2명 반영"],
  [{ kind: "LEAVE_OF_ABSENCE", mode: "schedule", count: 1 }, "휴직 1명 예약"],
  [{ kind: "orgMove", mode: "request", count: 3 }, "부서 이동 3개 결재 요청"],
  [{ kind: "TRANSFER", mode: "cancel", count: 1 }, "전보 1명 취소"],
  [{ kind: "TRANSFER", mode: "correct", count: 1 }, "전보 1명 정정"],
  [{ kind: "TRANSFER", mode: "revoke", count: 1 }, "전보 1명 철회"],
  [{ kind: "orgChange", mode: "withdraw" }, "조직 변경 회수"],
  [{ kind: "appointment", mode: "apply", count: 0 }, "발령 반영"],
  [{ kind: "ONBOARD", mode: "apply", count: 1, continuation: "next" }, "직원 등록 1명 반영 · 다음 직원"],
] as const)("builds a single outcome label for %j", (action, expected) => {
  expect(commitLabel(action)).toBe(expected);
});
