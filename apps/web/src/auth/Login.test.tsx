// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { Login } from "./Login";

const state = vi.hoisted(() => ({ experience: "baseline" as "baseline" | "console" }));
const search = vi.hoisted(() => ({ code: undefined as boolean | undefined }));
vi.mock("../experience/dom", async (original) => ({
  ...(await original<typeof import("../experience/dom")>()),
  useActiveExperienceId: () => state.experience,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), getRouteApi: () => ({ useSearch: () => search }) }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));
beforeAll(() => loadCatalog("ko"));
afterEach(() => { state.experience = "baseline"; });

test.each([undefined, true])("code recovery opens the existing code form (code=%s)", code => {
  search.code = code;
  const html = renderToStaticMarkup(<Login />);
  expect(html.includes('<details open="">')).toBe(code === true);
  expect(html.match(/autocomplete="one-time-code"/gi)).toHaveLength(1);
  if (code) {
    expect(html).not.toContain("처음이면");
    expect(html).toContain("일회용 코드");
    expect(html).toContain('data-code-summary="true"');
    expect(html).toContain(`aria-label="${t("auth.login.code")}"`);
  }
});

test("Login renders SignInPattern in Console experience and legacy card in baseline", () => {
  search.code = undefined;
  state.experience = "baseline";
  const baseHtml = renderToStaticMarkup(<Login />);
  expect(baseHtml).toContain('class="auth"');
  expect(baseHtml).not.toContain('data-pattern="sign-in"');

  state.experience = "console";
  const consoleHtml = renderToStaticMarkup(<Login />);
  expect(consoleHtml).toContain('data-pattern="sign-in"');
  expect(consoleHtml).toContain('data-floorplan="sign-in"');
});

test("Login suppresses the 10-character OTP hint when #otp= carries a cop_ operator invite", () => {
  search.code = undefined;
  vi.stubGlobal("window", { location: { hash: "#otp=cop_AbCdEf123456" } });
  try {
    const html = renderToStaticMarkup(<Login />);
    expect(html).toContain('<details open="">');
    expect(html).toContain('value="cop_AbCdEf123456"');
    expect(html).not.toContain("/10");
  } finally {
    vi.unstubAllGlobals();
  }
});
