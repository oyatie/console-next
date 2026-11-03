// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import type { Node } from "../../../reference/org/domain/structure";
import type { TreeView } from "../../../ui/tree/tree";
import { TargetTree } from "./target-tree";

const tree = vi.hoisted(() => ({ props: undefined as Parameters<typeof TreeView<Node>>[0] | undefined }));
vi.mock("../../../ui/tree/tree", () => ({ TreeView: (props: Parameters<typeof TreeView<Node>>[0]) => { tree.props = props; return null; } }));
const node = (id: string, kind: Node["kind"], children: Node[] = []): Node => ({ id, name: id, kind, children, headcount: 0, direct_headcount: 0, dispatched_headcount: 0, chips: [] });
beforeAll(() => loadCatalog("ko"));

test("a permitted descendant keeps disabled ancestors while an unrelated workplace is absent", () => {
  const child = node("담당 부서", "DEPARTMENT");
  const parent = node("상위 부서", "DEPARTMENT", [child]);
  const site = node("담당 사업장", "WORKPLACE", [parent]);
  const outside = node("다른 사업장", "WORKPLACE");
  const entity = node("법인", "LEGAL_ENTITY", [site, outside]);
  const choose = vi.fn();
  renderToStaticMarkup(<TargetTree label="어디로" entity={entity} show={n => n.id !== outside.id} selectable={n => n.id === child.id} why={() => undefined} right={() => ""} workplaces value={null} onChange={choose} />);
  const props = tree.props!;
  expect(props.childrenOf(entity)).toEqual([site]);
  expect(props.childrenOf(site)).toEqual([parent]);
  expect(props.childrenOf(parent)).toEqual([child]);
  expect(props.disabled).toEqual(new Set([entity.id, site.id, parent.id]));
  props.onSelect(parent.id);
  props.onSelect(site.id);
  expect(choose).not.toHaveBeenCalled();
  props.onSelect(child.id);
  expect(choose).toHaveBeenCalledExactlyOnceWith(child.id);
});
