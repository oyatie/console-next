// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ButtonHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { PASSKEY_ENROLLED, session } from "@console/api";
import { ensureSession } from "../lib/react/session";
import { SetupPasskey } from "./SetupPasskey";
import { autofillPaused } from "./sign-in-id";

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), register: vi.fn(), enroll: undefined as ButtonHTMLAttributes<HTMLButtonElement>["onClick"] }));
vi.mock("@tanstack/react-router", async original => ({ ...await original<typeof import("@tanstack/react-router")>(), useNavigate: () => mocks.navigate }));
vi.mock("@console/api", async original => ({ ...await original<typeof import("@console/api")>(), registerPasskey: mocks.register }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ isFetchedAfterMount: true, data: { body: "Terms", privacy: { body: "Privacy", policy_url: "https://example.com/privacy" } } }) }));
vi.mock("../ui/button/button", () => ({ Button: ({ children, onClick }: ButtonHTMLAttributes<HTMLButtonElement>) => {
  if (renderToStaticMarkup(<>{children}</>).includes(t("auth.setup.register"))) mocks.enroll = onClick;
  return <button>{children}</button>;
} }));
beforeAll(() => loadCatalog("ko"));
afterEach(() => { session.set(null); vi.unstubAllGlobals(); vi.clearAllMocks(); });

test.each([false, true])("initial enrollment returns to the interrupted screen only for its principal (changed=%s)", async changed => {
  const pair = (sub: string, enrolling = false) => ({ access_token: `h.${btoa(JSON.stringify({ sub, org: "tenant", enrollment: enrolling }))}.s`, token_type: "Bearer" as const, requires_passkey_setup: enrolling, privacy_consent_accepted: true, refresh_expires_at: "2027-01-01T00:00:00Z" });
  session.set(pair("user"));
  session.setConsentAccepted(false);
  await expect(ensureSession({ location: { pathname: "/people/person", href: "/people/person?view=history#report" } })).rejects.toMatchObject({ options: { to: "/setup-passkey" } });
  session.set(pair(changed ? "other" : "user", true));
  mocks.register.mockImplementation(async () => { session.set(pair(changed ? "other" : "user")); return null; });
  renderToStaticMarkup(<SetupPasskey />);
  expect(mocks.enroll).toBeDefined();
  await mocks.enroll!({} as never);
  expect(mocks.register).toHaveBeenCalledOnce();
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({ href: changed ? "/" : "/people/person?view=history#report" });
});

test("a refused post-enrollment sign-in pauses autofill before returning to login", async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  session.set({ access_token: `h.${btoa(JSON.stringify({ sub: "user", org: "tenant", enrollment: true }))}.s`, token_type: "Bearer", requires_passkey_setup: true, privacy_consent_accepted: true, refresh_expires_at: "2027-01-01T00:00:00Z" });
  mocks.register.mockRejectedValueOnce(new Error(PASSKEY_ENROLLED));
  mocks.navigate.mockImplementationOnce(() => { expect(autofillPaused()).toBe(true); });
  renderToStaticMarkup(<SetupPasskey />);
  expect(autofillPaused()).toBe(false);
  await mocks.enroll!({} as never);
  expect(mocks.register).toHaveBeenCalledOnce();
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/login", search: { enrolled: true } });
  expect(autofillPaused()).toBe(true);
});
