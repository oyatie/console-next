import { expect, test } from "@playwright/test";
import { registerEmployee } from "../flows";
import { addDepts } from "../helpers/structure";
import { tenantInSetup } from "../setup-flows";
import { apiOf, bearerOf, headcount } from "../helpers/api";

// @regression: registering into a 부서 made a moment earlier could be a dead press. The sheet opened before the
// company's structure re-read had landed, so for that moment the new 부서's workplace looked unknown (a hidden
// 「workplace」 gap): the press sent nothing and, the read landing, no gap was left to name (structure-move,
// structure-dept and structure-governed in full runs, about one press in three). A press made while the places are
// still being read now waits for them and registers.
test("registering into 부서 made a moment earlier: every press registers", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin } = await tenantInSetup(browser, "newunitreg", "새부서등록");
  const api = apiOf(admin, bearerOf(admin));
  for (const [i, unit] of ["설비보전팀", "품질관리팀", "생산관리팀", "자재팀"].entries()) {
    await addDepts(admin, "본점", [unit]);
    await registerEmployee(admin, { name: `직원${i + 1}`, unit });
  }
  expect(await headcount(api)).toBe(4);
});
