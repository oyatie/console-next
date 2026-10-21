import { expect, it } from "vitest";
import { unitPath } from "./path";

const tree = [{ id: "E", name: "(주)새온정밀", children: [{ id: "W", name: "평택공장", children: [{ id: "D", name: "생산부", children: [{ id: "U", name: "생산관리팀", version: 4, children: [] }] }] }] }];

it("names a unit's path from the legal entity down and carries its version", () => {
  expect(unitPath(tree, "U")).toMatchObject({ path: ["(주)새온정밀", "평택공장", "생산부"], node: { version: 4 } });
  expect(unitPath(tree, "gone")).toBeUndefined();
});
