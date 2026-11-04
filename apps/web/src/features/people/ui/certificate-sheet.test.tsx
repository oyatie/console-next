// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { queryPath } from "../../../lib/query";
import { ApiError } from "../../../reference/authz/api";
import { loadCatalog, t } from "@console/i18n";
import type { ComponentProps, ReactNode } from "react";
import { CertificateSheet } from "./certificate-sheet";
import { CertificatesPage } from "./certificates-page";

const state = vi.hoisted(() => ({
  fresh: true, success: true, manage: undefined as boolean | undefined,
  entities: ["company"], error: null as unknown, reads: [] as string[],
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (query: Parameters<typeof queryPath>[0]) => {
    const path = queryPath(query);
    state.reads.push(path);
    return { isSuccess: state.success, isFetchedAfterMount: state.fresh, isPending: false, isFetching: !state.fresh,
      error: null, refetch: () => Promise.resolve(),
      data: path === "/api/v1/access/me" ? { decisions: { certificate_settings_manage: state.manage } }
        : { can_manage: state.manage, settings: state.entities.map(legal_entity_id => ({ legal_entity_id })) },
    };
  },
  useInfiniteQuery: () => ({ isPending: false, isError: false, isSuccess: true, data: { pages: [{ items: [] }] }, hasNextPage: false, isFetchingNextPage: false, isFetchNextPageError: false, fetchNextPage: () => Promise.resolve(), refetch: () => Promise.resolve() }),
}));
vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useSearch: () => ({}) }),
  useNavigate: () => () => {},
  useLocation: () => "",
  Link: ({ children, to, hash }: { children: ReactNode; to?: string; hash?: string }) => <span data-to={to} data-hash={hash}>{children}</span>,
}));
vi.mock("../../../lib/react/command", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/react/command")>(),
  useCommand: () => ({ error: state.error, isPending: false }),
}));
vi.mock("../../../ui/sheet/sheet", () => ({ Sheet: ({ children, notice, actions }: { children: ReactNode; notice: ReactNode; actions: ReactNode }) => <div><div data-notice>{notice}</div><div data-body>{children}</div>{actions}</div> }));
vi.mock("./card-who", () => ({ Who: () => null }));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { state.fresh = true; state.success = true; state.manage = undefined; state.entities = ["company"]; state.error = null; state.reads = []; });
const c = { e: { id: "person", legal_entity_id: "company", status: "ACTIVE" }, place: { entity: "회사" } } as ComponentProps<typeof CertificateSheet>["c"];
const renderSheet = () => renderToStaticMarkup(<CertificateSheet c={c} onClose={() => {}} />);
const remedy = () => `data-to="/people/certificates" data-hash="certificate-settings">${t("empDoc.certificate.settings")}</span>`;

test.each([[false, true, true], [true, true, true], [true, false, true], [undefined, true, true], [true, true, false]])("settings refusal remedy uses a fresh manage decision: %s %s %s", (allowed, fresh, success) => {
  state.manage = allowed; state.fresh = fresh; state.success = success;
  state.error = new ApiError(409, "certificate_settings_required", "", []);
  const markup = renderSheet();
  const [notice = ""] = markup.split("<div data-body>");
  expect(notice.includes(remedy())).toBe(allowed === true && fresh && success);
});

test.each([true, false, undefined])("missing settings block entry for the employee's entity: manage=%s", allowed => {
  state.manage = allowed;
  state.entities = ["another-company"];
  const markup = renderSheet();
  expect(markup).toContain(t("empDoc.certificate.error.certificate_settings_required"));
  expect(markup).not.toContain('role="radio"');
  expect(markup).not.toContain('type="checkbox"');
  expect(markup).not.toContain(t("empDoc.certificate.purpose"));
  expect(markup.includes(remedy())).toBe(allowed === true);
  expect(state.reads).toContain("/api/v1/hr/certificate-settings");
});

test("cached settings cannot unlock entry before a fresh answer", () => {
  state.fresh = false;
  const markup = renderSheet();
  expect(markup).not.toContain('role="radio"');
  expect(markup).not.toContain(t("empDoc.certificate.purpose"));
});

test("configured legal entity admits the issuance form", () => {
  expect(renderSheet()).toContain(t("empDoc.certificate.purpose"));
});

test.each([true, false, undefined])("register uses only the lightweight server decision: %s", allowed => {
  state.manage = allowed;
  const markup = renderToStaticMarkup(<CertificatesPage />);
  expect(markup.includes('id="certificate-settings"')).toBe(allowed === true);
  expect(state.reads).not.toContain("/api/v1/hr/certificate-settings");
  expect(state.reads).toContain("/api/v1/access/me");
});
