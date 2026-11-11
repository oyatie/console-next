// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { Login } from "./Login";

const search = vi.hoisted(() => ({ code: undefined as boolean | undefined }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), getRouteApi: () => ({ useSearch: () => search }) }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));
beforeAll(() => loadCatalog("ko"));

test.each([undefined, true])("code recovery opens the existing code form (code=%s)", code => {
  search.code = code;
  const html = renderToStaticMarkup(<Login />);
  expect(html.includes('<details open="">')).toBe(code === true);
  expect(html.match(/autocomplete="one-time-code"/gi)).toHaveLength(1);
  if (code) {
    expect(html).not.toContain("처음이면");
    expect(html).toContain("일회용 코드");
  }
});
