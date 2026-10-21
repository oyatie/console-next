import { describe, expect, it } from "vitest";
import { inOrder } from "./in-order";

describe("inOrder", () => {
  it("follows the stored order, not the names, and keeps unlisted items after it as given", () => {
    expect(inOrder(["가팀", "외부", "나팀", "다팀", "기타"], ["다팀", "가팀", "나팀"])).toEqual(["다팀", "가팀", "나팀", "외부", "기타"]);
  });
  it("takes the first place of a name the order lists twice", () => {
    expect(inOrder(["b", "a"], ["a", "b", "a"])).toEqual(["a", "b"]);
  });
});
