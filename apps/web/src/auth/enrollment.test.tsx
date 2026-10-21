import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { SetupPasskey } from "./Login";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), getRouteApi: () => ({ useSearch: () => ({}) }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { accepted: false, policy_version: "2026-10" }, isPending: false, isError: false }) }));
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

