// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { checkTerms } from "./check-copy.mjs";

test.each(["people.place", "person.place", "roster.review.place", "home.review.place"])("%s uses the one person-place vocabulary", (id) => {
  expect(checkTerms([{ id, where: "ko/test.ts", text: "소속 지점 미지정" }], [])).toEqual(expect.arrayContaining([expect.stringContaining("term.personPlace")]));
  expect(checkTerms([{ id, where: "ko/test.ts", text: "미배치 · 사업장 없음 · 배치" }], [])).toEqual([]);
});

test.each([
  ["workplace.kind.BRANCH", "지점"],
  ["tax.incomeLaw", "소득세법의 지점"],
  ["roster.scope.branches", "내 지점에 속한 직원만 보입니다."],
  ["people.field.homeBranch", "소속 지점"],
])("%s retains object kinds, legal citations and explicitly deferred routing copy", (id, text) => {
  expect(checkTerms([{ id, where: "ko/test.ts", text }], [])).toEqual([]);
});
