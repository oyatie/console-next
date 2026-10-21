import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import type { OrgStructureNode } from "@console/api/pending";
import { buildStructure } from "../domain/model";
import { chartSvg, exportPages } from "./use-export";

const n = (kind: OrgStructureNode["kind"], id: string, children: OrgStructureNode[] = [], extra: Partial<OrgStructureNode> = {}): OrgStructureNode =>
  ({ kind, id, name: id, headcount: 2, direct_headcount: 0, dispatched_headcount: 0, chips: [], version: 1, children, ...extra });
const s = buildStructure({
  tenant_name: "T",
  phase: "SETUP",
  unplaced: [],
  entities: [n("LEGAL_ENTITY", "e1", [n("WORKPLACE", "w1", [n("DEPARTMENT", "d1", [], { head: { name: "Hong" } as never, code: "PT-9" })]), n("WORKPLACE", "w2")])],
});

beforeAll(() => loadCatalog("ko"));

test("one page fitted, or one page per workplace under the start", () => {
  expect(exportPages(s, s.root, "one", false)).toHaveLength(1);
  expect(exportPages(s, s.root, "one", true).map((L) => L.boxes[L.boxes.length - 1]!.node.id)).toEqual(["w1", "w2"]);
  expect(exportPages(s, s.byId.get("w1")!, "one", true)).toHaveLength(1);
});

test("a printed box carries the fields chosen, and no one's name when personal data is left out", () => {
  const [L] = exportPages(s, s.byId.get("w1")!, "one", false);
  const svg = (fields: ("head" | "people" | "code")[], redact = false) => chartSvg(L!, { redact, stamp: "", fields: new Set(fields) });
  expect(svg(["head", "code"])).toContain("Hong");
  expect(svg(["head", "code"])).toContain("PT-9");
  expect(svg(["people"])).not.toContain("Hong");
  expect(svg(["head"], true)).not.toContain("Hong");
});
