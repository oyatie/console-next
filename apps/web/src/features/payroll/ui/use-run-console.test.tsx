// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { useRunConsole } from "./use-run-console";

const ENTITY = "entity-a";
const state = vi.hoisted(() => ({ runEntity: "entity-a" }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    const path = String(queryKey[0]);
    if (path === "/api/v1/payroll/pay-groups") {
      return {
        isPending: false, error: null, data: {
          legal_entities: [{ id: "entity-a", name: "Entity A" }, { id: "entity-b", name: "Entity B" }],
          items: [{ id: "group-1", legal_entity_id: "entity-b", name: "Other entity's group" }, { id: "group-1", legal_entity_id: ENTITY, name: "Base group" }],
        },
      };
    }
    if (path === "/api/v1/payroll/runs/{id}") {
      return { isPending: false, error: null, isPlaceholderData: false, data: { run: { id: "run-1", pay_group_id: "group-1", legal_entity_id: state.runEntity, attribution_month: "2026-10", status: "CALCULATED" }, lines: [], lines_total: 0, lines_offset: 0, missing_bank_account_count: 0, exceptions_open: 0 } };
    }
    return { isPending: true, error: null, data: undefined };
  },
}));

beforeAll(() => loadCatalog("ko"));
function Probe() {
  return <output>{useRunConsole("run-1").groupLabel}</output>;
}

test("a run names its own pay group, matched by id within the run's legal entity", () => {
  state.runEntity = ENTITY;
  expect(renderToStaticMarkup(<Probe />)).toBe("<output>Base group</output>");
});

test("a group id that only matches in another legal entity is never borrowed", () => {
  state.runEntity = "entity-c";
  expect(renderToStaticMarkup(<Probe />)).toBe(`<output>${t("payroll.rule.unknown")}</output>`);
});
