// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { ApiError } from "../../../reference/authz/api";
import { loadCatalog, t } from "@console/i18n";
import type { ComponentProps, ReactNode } from "react";
import { CertificateSheet } from "./certificate-sheet";
import { CertificatesPage } from "./certificates-page";

const permission = vi.hoisted(() => ({ isSuccess: true, isFetchedAfterMount: true, data: { can_manage: undefined as boolean | undefined } }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => permission,
  useInfiniteQuery: () => ({ isPending: false, isError: false, isSuccess: true, data: { pages: [{ items: [] }] }, hasNextPage: false, isFetchingNextPage: false, isFetchNextPageError: false, fetchNextPage: () => Promise.resolve(), refetch: () => Promise.resolve() }),
}));
vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useSearch: () => ({}) }),
  useNavigate: () => () => {},
  Link: ({ children, to, hash }: { children: ReactNode; to?: string; hash?: string }) => <span data-to={to} data-hash={hash}>{children}</span>,
}));
vi.mock("../../../lib/react/command", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/react/command")>(),
  useCommand: () => ({ error: new ApiError(422, "certificate_settings_required", "", []), isPending: false }),
}));
vi.mock("../../../ui/sheet/sheet", () => ({ Sheet: ({ children, notice, actions }: { children: ReactNode; notice: ReactNode; actions: ReactNode }) => <div><div data-notice>{notice}</div><div data-body>{children}</div>{actions}</div> }));
vi.mock("./card-who", () => ({ Who: () => null }));
beforeAll(() => loadCatalog("ko"));

test.each([[false, true, true], [true, true, true], [true, false, true], [undefined, true, true], [true, true, false]])("settings remedy uses a fresh manage decision inside CommandError: %s %s %s", (allowed, fresh, success) => {
  permission.data.can_manage = allowed;
  permission.isFetchedAfterMount = fresh;
  permission.isSuccess = success;
  const c = { e: { id: "person", status: "ACTIVE" }, place: { entity: "회사" } } as ComponentProps<typeof CertificateSheet>["c"];
  const markup = renderToStaticMarkup(<CertificateSheet c={c} onClose={() => {}} />);
  expect(markup).toContain('data-composer-section="effects"');
  const [notice = "", body = ""] = markup.split("<div data-body>");
  const remedy = `data-to="/people/certificates" data-hash="certificate-settings">${t("empDoc.certificate.settings")}</span>`;
  expect(notice.includes(remedy)).toBe(allowed === true && fresh && success);
  expect(body.includes(remedy)).toBe(false);
});

test.each([true, false, undefined])("register page exposes certificate settings control only when server decision admits: %s", (allowed) => {
  permission.data.can_manage = allowed;
  permission.isSuccess = true;
  const markup = renderToStaticMarkup(<CertificatesPage />);
  expect(markup.includes('id="certificate-settings"')).toBe(allowed === true);
});
