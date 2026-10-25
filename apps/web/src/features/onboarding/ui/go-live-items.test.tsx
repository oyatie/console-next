import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { Warnings } from "./go-live-items";

beforeAll(() => loadCatalog("ko"));
const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });

test.each([null, "place_people"])("unknown record kinds stay named without a guessed link (%s)", (remedy) => {
  const html = renderToStaticMarkup(<RouterContextProvider router={router}><Warnings items={[{
    code: "future_warning", count: 1, remedy,
    records: [{ kind: "future_kind", id: "record", name: "Visible record", legal_entity_id: "entity" }],
  }]} /></RouterContextProvider>);
  expect(html).toContain("Visible record");
  expect(html).not.toContain("/org/entities/entity");
  expect(html).not.toContain("/people/record");
});

test("a missing department names the gap and opens the bulk remedy", () => {
  const html = renderToStaticMarkup(<RouterContextProvider router={router}><Warnings items={[{
    code: "unresolved_departments", count: 1, remedy: "assign_departments",
    records: [{ kind: "employee", id: "person", name: "김직원", legal_entity_id: "entity" }],
  }]} /></RouterContextProvider>);
  expect(html).toContain("부서 없음");
  expect(html).toContain("지정");
  expect(html).toContain('href="/people/unplaced"');
  expect(html).not.toContain('href="/people/person?act=TRANSFER"');
});
