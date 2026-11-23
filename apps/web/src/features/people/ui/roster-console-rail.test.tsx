// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { RosterConsoleRail } from "./roster-console-rail";

beforeAll(() => loadCatalog("ko"));

function renderRail(over: Partial<Parameters<typeof RosterConsoleRail>[0]> = {}) {
  return renderToStaticMarkup(
    <RosterConsoleRail
      entities={[]}
      facets={undefined}
      unit={null}
      expandedEntities={new Set()}
      toggleEntityExpand={vi.fn()}
      empTypes={new Set()}
      setEmpTypes={vi.fn()}
      review={[]}
      registerMissingCount={0}
      addressMissingOnly={false}
      setAddressMissingOnly={vi.fn()}
      probationOnly={false}
      setProbationOnly={vi.fn()}
      soonDays={60}
      contractSoonCount={0}
      activeFilterCount={0}
      q=""
      status="current"
      setFilter={vi.fn()}
      resetAll={vi.fn()}
      {...over}
    />,
  );
}

test("reset button is disabled when no filters or url ids are active, and enabled on /people?ids=...", () => {
  const clearLabel = t("people.rail.clear");
  const idleHtml = renderRail({ activeFilterCount: 0, idsActive: false });
  const idleReset = idleHtml.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((b) => b.includes(clearLabel));
  expect(idleReset).toBeDefined();
  expect(idleReset).toContain("disabled");

  const idsHtml = renderRail({ activeFilterCount: 1, idsActive: true });
  const idsReset = idsHtml.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((b) => b.includes(clearLabel));
  expect(idsReset).toBeDefined();
  expect(idsReset).not.toContain("disabled");
});
