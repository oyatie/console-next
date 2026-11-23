// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { ApiError } from "../reference/authz/api";
import { BulkMoveConsole } from "../features/org/ui/bulk-move-console";
import { GoLiveConsole } from "../features/onboarding/ui/go-live-console";
import { RequestLookupConsole, RequestPageConsole } from "../features/requests/ui/request-console";
import { BulkEditConsole } from "../features/org-bulk/ui/bulk-edit-console";
import { EntityBulkPage } from "../features/entity/ui/entity-bulk-page";
import { Button } from "../ui/button/button";

const state = vi.hoisted(() => ({
  search: {} as Record<string, string>,
  params: { id: "req-1" },
}));

vi.mock("../experience/dom", async (original) => ({
  ...(await original<object>()),
  useActiveExperienceId: () => "console",
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  getRouteApi: () => ({
    useSearch: () => state.search,
    useParams: () => state.params,
    useNavigate: () => vi.fn(),
  }),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <span data-to={to} {...props}>{children}</span>
  ),
}));

vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<object>()),
  useQuery: () => ({ data: undefined, isPending: true, isError: false, error: null, refetch: vi.fn() }),
}));

vi.mock("../lib/react/command", async (original) => ({
  ...(await original<object>()),
  useCommand: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
}));

beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  state.search = {};
  state.params = { id: "req-1" };
});

test("BulkMoveConsole renders WizardPattern (P8) and sets inert on body when refused", () => {
  const ready = { data: { phase: "SETUP" }, isPending: false, isError: false, isSuccess: true, error: null, refetch: vi.fn() };
  const html = renderToStaticMarkup(
    <BulkMoveConsole
      q={ready}
      units={ready}
      title={t("bulkMove.title", { n: 2 })}
      path={[]}
      setup
      available
      canMove
      tools={null}
      onClose={vi.fn()}
      showClose
      pending={false}
      error={new ApiError(403, "forbidden", "denied")}
      blockers={[]}
      whereSection={<div data-slot="where" />}
      whatSection={<div data-slot="what" />}
      afterSection={<div data-slot="after" />}
      afterTitle="after"
      unmovable={null}
      mode="apply"
      count={2}
      onSubmit={vi.fn()}
      onSaveDraft={vi.fn()}
    />,
  );
  expect(html).toContain('data-pattern="wizard"');
  expect(html).toContain('data-floorplan="P-04"');
  expect(html).toContain('inert=""');
});

test("GoLiveConsole renders WizardPattern (P8) outside PatternShell gating", () => {
  const ready = { data: { ready: true, blockers: [] }, isPending: false, isError: false, isSuccess: true, error: null, refetch: vi.fn() };
  const html = renderToStaticMarkup(
    <GoLiveConsole
      q={ready}
      operating={false}
      notes={null}
      body={<div data-slot="checklist" />}
      aside={<div data-slot="summary" />}
      asideLabel="summary"
      consequence={<span>{t("setup.golive.title")}</span>}
      actions={<Button>{t("setup.golive.title")}</Button>}
    />,
  );
  expect(html).toContain('data-pattern="wizard"');
  expect(html).toContain('data-floorplan="P-04"');
  expect(html).toContain(t("setup.golive.title"));
});

test("BulkEditConsole renders FormPattern (P7)", () => {
  const ready = { data: { entities: [], phase: "SETUP" }, isPending: false, isSuccess: true, error: null, refetch: vi.fn() };
  const html = renderToStaticMarkup(
    <BulkEditConsole
      q={ready}
      hasWorkplaces
      countTitle={t("orgBulk.links.edit")}
      content={<div data-slot="grid" />}
      actions={<Button>{t("orgBulk.links.edit")}</Button>}
      onSubmit={vi.fn()}
    />,
  );
  expect(html).toContain('data-pattern="form"');
  expect(html).toContain('data-floorplan="P-04"');
  expect(html).toContain(t("orgBulk.links.edit"));
});

test("RequestLookupConsole renders P7 FormPattern and RequestPageConsole preserves P3 RecordPattern own/back on 404", () => {
  const lookupHtml = renderToStaticMarkup(
    <RequestLookupConsole sections={<div data-slot="lookup" />} actions={<Button type="submit">{t("requestOutcome.lookup")}</Button>} onSubmit={vi.fn()} />,
  );
  expect(lookupHtml).toContain('data-pattern="form"');
  expect(lookupHtml).toContain(t("requestOutcome.title"));

  const notFound = { data: undefined, isPending: false, isError: true, isSuccess: false, error: new ApiError(404, "request_not_found", "missing"), refetch: vi.fn() };
  const own = (code: string) => (code === "request_not_found" ? `${t("requestOutcome.notFound")} ${t("requestOutcome.remedy")}` : undefined);
  const pageHtml = renderToStaticMarkup(<RequestPageConsole q={notFound} own={own} sections={<div data-slot="outcome" />} />);
  expect(pageHtml).toContain('data-pattern="record"');
  expect(pageHtml).toContain(t("requestOutcome.notFound"));
  expect(pageHtml).toContain('data-to="/requests"');
});

test("EntityBulkPage renders WizardPattern (P8) when Console experience is active", () => {
  const html = renderToStaticMarkup(<EntityBulkPage paste />);
  expect(html).toContain('data-pattern="wizard"');
  expect(html).toContain(t("setup.entityBulk.paste"));
});
