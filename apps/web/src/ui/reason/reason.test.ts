import { expect, test } from "vitest";
import { reasonProblem } from "./reason";

test("a reason needs a code, and 기타 needs a memo", () => {
  expect(reasonProblem({ code: null, memo: "anything" }, "OTHER")).toBe("pick");
  expect(reasonProblem({ code: "OTHER", memo: "  " }, "OTHER")).toBe("memo");
  expect(reasonProblem({ code: "OTHER", memo: "why" }, "OTHER")).toBeNull();
  expect(reasonProblem({ code: "SCOPE", memo: "" }, "OTHER")).toBeNull();
});
