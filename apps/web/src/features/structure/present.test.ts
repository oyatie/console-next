// The tenant root is not a legal-entity node.
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { OrgStructure, OrgStructureNode } from "@console/api/pending";
import { loadCatalog } from "@console/i18n";
import { buildStructure } from "./domain/model";
import { expandedFor, layout } from "./domain/layout";
import { menuActions, nodeLabel, nodeName, unitCounts, type Gestures } from "./present";
import { chartSvg } from "./ui/use-export";

const n = (kind: OrgStructureNode["kind"], id: string, children: OrgStructureNode[] = []): OrgStructureNode => ({ kind, id, name: id, headcount: 1, direct_headcount: 0, dispatched_headcount: 0, chips: [], version: 1, children });
const tree = (entities: number): OrgStructure => ({
  tenant_name: "group",
  phase: "SETUP",
  unplaced: [],
  entities: Array.from({ length: entities }, (_, i) => n("LEGAL_ENTITY", `e${i}`, [n("WORKPLACE", `w${i}`)])),
});

beforeAll(() => loadCatalog("ko"));

test("every parent menu starts with its level's add and invokes that parent's gesture", () => {
  const s = buildStructure(tree(1));
  const entity = s.root.children[0]!;
  const site = entity.children[0]!;
  const dept = { ...site, kind: "dept" as const };
  const g: Gestures = { add: vi.fn(), rename: vi.fn(), move: vi.fn(), remove: vi.fn(), focusOn: vi.fn() };
  for (const [parent, label] of [[entity, "사업장 추가"], [site, "부서 추가"], [dept, "하위 부서 추가"]] as const) {
    const first = menuActions(parent, g)[0]!;
    expect(first).toMatchObject({ id: "add", label });
    first.onAction();
    expect(g.add).toHaveBeenLastCalledWith(parent);
  }
  expect(menuActions(s.root, g)).toEqual([]);
});

describe("the tenant root is never a company", () => {
  for (const count of [1, 2]) {
    const s = buildStructure(tree(count));
    const L = layout({ s, focus: s.root, expanded: expandedFor(s.root, "sites") });
    const root = L.boxes.find((b) => b.node.kind === "tenant")!;
    const entities = L.boxes.filter((b) => b.node.kind === "entity");

    test(`${count} 법인: the root is named 「전체 · 법인 n개」, never the account name or 회사`, () => {
      expect(nodeName(s.root)).toBe(`전체 · 법인 ${count}개`);
      for (const text of [nodeName(s.root), nodeLabel(s.root)]) {
        expect(text).not.toContain("group");
        expect(text).not.toContain("회사");
      }
    });

    test(`${count} 법인: the 법인 are the top boxes, under an unboxed header with no line hanging from it`, () => {
      expect(entities).toHaveLength(count);
      for (const e of entities) expect(e.y).toBeGreaterThanOrEqual(root.y + root.h);
      // The header spans the whole 법인 row, so it never reads as a parent box centred over them.
      expect(root.x).toBeLessThanOrEqual(Math.min(...entities.map((e) => e.x)));
      expect(root.x + root.w).toBeGreaterThanOrEqual(Math.max(...entities.map((e) => e.x + e.w)));
      expect(L.lines.some((l) => l.d.startsWith(`M${root.x + root.w / 2} ${root.y + root.h}`))).toBe(false);
    });

    test(`${count} 법인: the printed chart has no root box and no account name`, () => {
      const svg = chartSvg(L, { redact: false, stamp: "", fields: new Set(["people"]) });
      expect(svg).not.toContain("group");
      expect(svg).not.toContain(`<g transform="translate(${root.x},${root.y})"><rect`);
      expect(svg).toContain(nodeName(s.root));
    });
  }
});

// SPDX-License-Identifier: LicenseRef-Proprietary
test("unit counts have one meaning in cards, lists and panels", () => {
  const unit = { headcount: 148, children: [{ headcount: 100 }, { headcount: 36 }] };
  expect(unitCounts(unit)).toBe("직속 12 · 전체 148");
  expect(unitCounts({ headcount: 0, children: [] })).toBe("직속 0 · 전체 0");
});
