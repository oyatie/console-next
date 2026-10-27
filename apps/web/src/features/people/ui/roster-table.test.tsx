// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import type { components } from "@console/api/schema";
import { LongTable } from "../../../ui/long-table/long-table";
import { RosterTable } from "./roster-table";

type Employee = components["schemas"]["Employee"];
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { items: [{ id: "entity", workplaces: [{ id: "workplace", current: { name: "본사" } }] }] } }) }));
vi.mock("../../../ui/long-table/long-table", () => ({ LongTable: vi.fn(({ rows, columns }: Parameters<typeof LongTable<Employee>>[0]) => <>{rows.map((e) => <div key={e.id}>{columns.find((c) => c.id === "unit")?.cell(e)}</div>)}</>) }));
beforeAll(() => loadCatalog("ko"));

test.each([true, false])("placement comes from the workplace, even without a department (placed: %s)", (placed) => {
  const employee = { id: "person", name: "직원", legal_entity_id: "entity", workplace_id: placed ? "workplace" : null, org_unit: null, org_unit_id: null } as Employee;
  const html = renderToStaticMarkup(<RosterTable rows={[employee]} today="2026-10-25" shown={["unit"]} density="regular" label="people" hasMore={false} onLoadMore={() => undefined} empty={null} />);
  expect(html).toContain(placed ? "본사 · 사업장 직속" : "미배치");
  expect(html).not.toContain(placed ? "미배치" : "본사");
});

test.each([false, true])("only server-supported columns sort, including the exited roster (%s)", exited => {
  const onSort = vi.fn();
  renderToStaticMarkup(<RosterTable rows={[]} today="2026-10-25" exited={exited} shown={["unit", "hired", "type"]} density="regular" label="people" hasMore={false} onLoadMore={() => undefined} empty={null} sort="-employee_number" onSort={onSort} />);
  const props = vi.mocked(LongTable).mock.calls.at(-1)![0];
  expect(props.sortDescriptor).toEqual({ column: "number", direction: "descending" });
  expect(props.columns.filter(c => c.allowsSorting).map(c => c.id)).toEqual(exited ? ["number", "name", "unit"] : ["number", "name", "unit", "hired"]);
  for (const [column, key] of [["unit", "org_unit"], ["name", "name"], ["number", "employee_number"], ["hired", "hire_date"]]) {
    props.onSortChange!({ column: column!, direction: "ascending" });
    expect(onSort).toHaveBeenLastCalledWith(key);
    props.onSortChange!({ column: column!, direction: "descending" });
    expect(onSort).toHaveBeenLastCalledWith(`-${key}`);
  }
  onSort.mockClear();
  props.onSortChange!({ column: "type", direction: "ascending" });
  expect(onSort).not.toHaveBeenCalled();
});

test("a roster without a sort handler offers no sortable columns", () => {
  renderToStaticMarkup(<RosterTable rows={[]} today="2026-10-25" shown={["unit", "hired", "type"]} density="regular" label="people" hasMore={false} onLoadMore={() => undefined} empty={null} />);
  const props = vi.mocked(LongTable).mock.calls.at(-1)![0];
  expect(props.columns.filter(column => column.allowsSorting)).toEqual([]);
  expect(props.sortDescriptor).toBeUndefined();
  expect(props.onSortChange).toBeUndefined();
});
