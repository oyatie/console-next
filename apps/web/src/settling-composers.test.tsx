// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { LegalEntity } from "@console/api/pending";
import { placesOf, locate } from "./reference/org/domain/structure";
import { structure } from "../../../e2e/mock/fixtures";
import { WorkplaceSheet } from "./features/entity/ui/workplace-sheets";
import { WorkplaceCreateSheet } from "./features/entity/ui/workplace-create-sheet";
import { BulkMovePage } from "./features/org/ui/bulk-move-page";

const state = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, erase: true, pending: false, places: new Map(), pick: undefined as undefined | ((id: string) => void), submit: undefined as undefined | (() => void) }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (initial: unknown) => {
  const at = state.cursor++;
  if (!(at in state.slots)) state.slots[at] = typeof initial === "function" ? initial() : initial;
  return [state.slots[at], (next: unknown) => { state.slots[at] = typeof next === "function" ? next(state.slots[at]) : next; }];
} }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { delete: { allowed: state.erase } } }) }));
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useSearch: () => ({ ids: "dept" }) }), useNavigate: () => vi.fn() }));
vi.mock("./lib/react/command", () => ({ useCommand: () => ({ isPending: state.pending, mutate: () => { state.pending = true; } }) }));
vi.mock("./reference/org/ui/use-structure", () => ({ useStructure: () => ({ setup: true, tenant: "Company", places: state.places, q: { status: "success", fetchStatus: "idle", data: {} } }) }));
vi.mock("./reference/entity/ui/use-ei-unit", () => ({ useEiUnit: () => ({}) }));
vi.mock("./features/org/ui/use-govern", () => ({ useGovern: () => ({ g: { date: "2026-11-04" }, missing: [] }), useGovernSubmit: () => ({ isPending: false }) }));
vi.mock("./features/org/domain/bulk-move", () => ({ bulkPlan: () => ({ totals: { units: 1, members: 0, siteChanged: 0 }, items: { moves: 1, renames: 0 }, setupOps: () => [], unresolved: 0 }) }));
vi.mock("./ui/composer/composer", () => ({ Composer: ({ children, onSubmit }: { children: ReactNode; onSubmit?: () => void }) => { state.submit = onSubmit; return <div>{children}</div>; } }));
vi.mock("./ui/button/button", () => ({ Button: () => null }));
vi.mock("./lib/react/query-state", () => ({ QueryState: ({ children }: { children: () => ReactNode }) => children() }));
vi.mock("./features/org/ui/target-tree", () => ({ TargetTree: ({ onChange }: { onChange: (id: string) => void }) => { state.pick = onChange; return <output data-state="target" />; } }));
vi.mock("./features/org/ui/mini-tree", () => ({ MiniTree: () => null, TreeLegend: () => null }));
vi.mock("./features/org/ui/bulk-move-table", () => ({ BulkMoveTable: () => null }));
vi.mock("./features/entity/ui/workplace-delete-sheet", () => ({ WorkplaceDeleteSheet: () => <output data-state="delete" /> }));
vi.mock("./features/entity/ui/workplace-close-sheet", () => ({ WorkplaceCloseSheet: () => <output data-state="close" /> }));
vi.mock("./features/entity/ui/use-ref", () => ({ useAddressSearch: () => ({}) }));
vi.mock("./ui/sheet/sheet", () => ({ Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("./ui/field/field", () => ({ Field: ({ warning }: { warning?: ReactNode }) => <div>{warning}</div>, TextInput: () => null }));
vi.mock("./ui/address-field/address-field", () => ({ AddressField: () => null }));
vi.mock("./features/entity/ui/workplace-registration-choice", () => ({ RegistrationChoice: () => null }));
vi.mock("./features/entity/ui/workplace-statutory-choices", () => ({ StatutoryChoices: () => null }));
vi.mock("./features/entity/ui/use-workplace-create", () => ({ useWorkplaceCreate: () => ({ w: { name: "New", isAbstract: true }, mode: "NOT_REQUIRED", save: { isPending: state.pending }, missing: {}, problems: {} }) }));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { state.slots = []; state.cursor = 0; state.pending = false; state.erase = true; });
const render = (element: ReactNode) => { state.cursor = 0; return renderToStaticMarkup(element); };

test("a workplace deletion does not become a different composer when end-options refetches", () => {
  const tree = structure(1);
  const at = locate(placesOf(tree), tree.entities[0]!.children[0]!.id)!;
  const view = <WorkplaceSheet act="wp-delete" at={at} setup onClose={() => {}} onSelect={() => {}} onAct={() => {}} />;
  expect(render(view)).toContain("delete");
  state.erase = false;
  expect(render(view)).toContain("delete");
  expect(render(view)).not.toContain("close");
});

test("a just-created workplace does not flash its own duplicate-name warning during settle", () => {
  const entity = { id: "entity", registrations: [], workplaces: [] } as unknown as LegalEntity;
  expect(render(<WorkplaceCreateSheet e={entity} setup onClose={() => {}} onSaved={() => {}} />)).not.toContain(t("entityOps.create.twin", { name: "New", address: t("entityOps.info.none") }));
  state.pending = true;
  const refreshed = { ...entity, workplaces: [{ id: "new", current: { name: "New" } }] } as LegalEntity;
  const warning = t("entityOps.create.twin", { name: "New", address: t("entityOps.info.none") });
  render(<WorkplaceCreateSheet e={refreshed} setup onClose={() => {}} onSaved={() => {}} />);
  expect(render(<WorkplaceCreateSheet e={refreshed} setup onClose={() => {}} onSaved={() => {}} />)).not.toContain(warning);
  state.pending = false;
  render(<WorkplaceCreateSheet e={refreshed} setup onClose={() => {}} onSaved={() => {}} />);
  expect(render(<WorkplaceCreateSheet e={refreshed} setup onClose={() => {}} onSaved={() => {}} />)).toContain(warning);
});

test("a moving selection remains visible until its command has settled", () => {
  const tree = structure(1);
  const workplace = tree.entities[0]!.children[0]!;
  workplace.children[0]!.id = "dept";
  state.places = placesOf(tree);
  render(<BulkMovePage />);
  state.pick!(workplace.id);
  render(<BulkMovePage />);
  expect(state.submit).toBeDefined();
  state.submit!();
  state.places = new Map();
  render(<BulkMovePage />);
  expect(render(<BulkMovePage />)).toContain("target");
});
