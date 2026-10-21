import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { SetupPasskey } from "./Login";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), getRouteApi: () => ({ useSearch: () => ({}) }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { accepted: false, policy_version: "2026-10" }, isPending: false, isError: false }) }));
beforeAll(() => loadCatalog("ko"));

test("first sign-in enrolls a passkey without consent ticks or inferred service acceptance", () => {
  const html = renderToStaticMarkup(<SetupPasskey />);
  expect(html).not.toContain('type="checkbox"');
  expect(html).not.toContain("서비스 이용약관");
  expect(html).not.toContain("개인정보 수집·이용");
  expect(html).toContain("패스키 등록");
  expect(html).not.toContain("disabled");
});
