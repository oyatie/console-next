// SPDX-License-Identifier: LicenseRef-Proprietary
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { Node } from "../domain/structure";
import { OrderButtons } from "./order-buttons";

const node = (id: string, children: Node[] = []): Node => ({ kind: "DEPARTMENT", id, name: id, headcount: 0, direct_headcount: 0, dispatched_headcount: 0, chips: [], children });
const children = [node("first"), node("middle"), node("last")];
const parent = node("parent", children);
const render = (child: Node, editing?: boolean, atParent = parent) => renderToStaticMarkup(
  <QueryClientProvider client={new QueryClient()}><OrderButtons parent={atParent} node={child} kind="DEPARTMENT" editing={editing} /></QueryClientProvider>,
);
beforeAll(() => loadCatalog("ko"));

test("read mode offers no reorder controls by default or explicitly", () => {
  expect(render(children[1]!)).toBe("");
  expect(render(children[1]!, false)).toBe("");
});

test.each([0, 1, 2])("edit mode offers only possible moves for sibling %i", (at) => {
  const child = children[at]!;
  const html = render(child, true);
  const up = t("orgStructure.order.up", { name: child.name });
  const down = t("orgStructure.order.down", { name: child.name });
  if (at > 0) expect(html).toContain(up);
  else expect(html).not.toContain(up);
  if (at < children.length - 1) expect(html).toContain(down);
  else expect(html).not.toContain(down);
  expect(html).not.toContain("disabled");
});

test("a single child and a child outside the sibling list have no moves", () => {
  expect(render(children[0]!, true, node("parent", [children[0]!]))).toBe("");
  expect(render(node("missing"), true)).toBe("");
});
