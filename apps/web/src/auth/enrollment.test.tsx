// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { SetupPasskey } from "./Login";

vi.mock("@console/api", async (importOriginal) => ({ ...await importOriginal<typeof import("@console/api")>(), session: { stage: "enroll", claims: null } }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), getRouteApi: () => ({ useSearch: () => ({}) }) }));
const query = vi.hoisted(() => ({ pending: false, failed: false }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: query.pending || query.failed ? undefined : { accepted: false, policy_version: "2026-10", version: "service-v1", sha256: "a".repeat(64), body: "Store service terms exact text", privacy: { version: "notice-v1", sha256: "b".repeat(64), body: "Store notice exact text 휴대전화번호", policy_url: "https://cosskorea.com/privacy", review_pending: true } }, isPending: query.pending, isError: query.failed }) }));
beforeEach(() => { query.pending = false; query.failed = false; });
beforeAll(() => loadCatalog("ko"));

test("first sign-in requires privacy notice and terms consent before passkey enrollment", () => {
  const html = renderToStaticMarkup(<SetupPasskey />);
  expect(html).toContain('type="checkbox"');
  expect(html).toContain("서비스 이용약관");
  expect(html).toContain("개인정보 수집·이용");
  expect(html).toContain("https://cosskorea.com/privacy");
  expect(html).toContain("disabled");
  expect(html).not.toContain('name="name"');
  expect(html).not.toContain('name="phone"');
  expect(html).not.toContain('name="email"');
});

test("no personal-data inputs render on setup-passkey", () => {
  const html = renderToStaticMarkup(<SetupPasskey />);
  expect(html).not.toContain('input type="text"');
  expect(html).not.toContain("주민등록번호");
  expect(html).not.toContain("생년월일");
});

test("consent disclosures stay outside checkbox labels and display store documents", () => {
  const html = renderToStaticMarkup(<SetupPasskey />);
  expect(html).toContain("Store service terms exact text");
  expect(html).toContain("Store notice exact text 휴대전화번호");
  const labels = [...html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)].map((m) => m[1]);
  expect(labels.some((label) => label!.includes("개인정보 수집·이용"))).toBe(true);
  for (const label of labels) {
    expect(label).not.toContain("<details");
    expect(label).not.toContain("휴대전화번호");
  }
  expect(html).toContain("aria-describedby");
});

test("document load faults show a retry and never enable commit", () => {
  query.failed = true;
  const html = renderToStaticMarkup(<SetupPasskey />);
  expect(html).toContain("동의 문서를 불러오지 못했습니다");
  expect(html).toContain("다시 불러오기");
  const commit = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find((m) => m[2]!.includes("동의하고 패스키 등록"));
  expect(commit).toBeDefined();
  expect(commit?.[1]).toMatch(/\bdisabled/);
});
test("pending documents keep required confirmations disabled", () => {
  query.pending = true;
  const html = renderToStaticMarkup(<SetupPasskey />);
  expect(html).toContain('role="status"');
  expect(html).toContain('type="checkbox"');
  expect(html).toMatch(/<input[^>]*disabled/);
});
