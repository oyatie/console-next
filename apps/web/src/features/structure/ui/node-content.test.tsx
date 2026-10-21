// regression (UX-R2 company-25): a 법인 closed today was drawn live, and a closed 사업장 read 「폐업」 though its sheet
// promised 「폐쇄됨」 (one vocabulary: 사업장 = 폐쇄, 등록증 = 폐업, 법인 = 종료).
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import type { ChartNode, Chip } from "../domain/model";
import { NodeContent } from "./node-content";

beforeAll(() => loadCatalog("ko"));

const node = (kind: ChartNode["kind"], name: string, chips: Chip[] = [], children: ChartNode[] = [], primary = false): ChartNode =>
  ({ id: name, kind, name, headcount: 0, chips, depth: 1, children, primary });
const html = (n: ChartNode, lod: "full" | "m" = "full") =>
  renderToStaticMarkup(<NodeContent box={{ node: n, lod, x: 0, y: 0, w: 1, h: 1 }} counts={{ entities: 1, sites: 2, depts: 0 }} />);

test("a closed 사업장 reads 폐쇄됨, never 폐업", () => {
  const out = html(node("site", "판교지점", ["closed"]));
  expect(out).toContain("폐쇄됨");
  expect(out).not.toContain("폐업");
});

test("a 법인 whose 대표 사업장 is closed is drawn ended at every size; a closed branch alone does not end it", () => {
  const ended = node("entity", "새온정밀", [], [node("site", "본사", ["closed"], [], true), node("site", "지점", ["closed"])]);
  expect(html(ended)).toContain("종료");
  expect(html(ended, "m")).toContain("종료");
  const live = node("entity", "새온정밀", [], [node("site", "본사", [], [], true), node("site", "지점", ["closed"])]);
  expect(html(live)).not.toContain("종료");
});
