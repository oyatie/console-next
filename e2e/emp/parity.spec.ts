import { expect, test } from "@playwright/test";
import { go } from "../flows";
import { startOperations } from "../setup-flows";
import { cardFrames } from "./frames-card";
import { rosterFrames } from "./frames-roster";
import { sheetFrames } from "./frames-sheets";
import { PARITY_OUT, parityUse, shot } from "./shot";
import { heroHistory } from "./history";
import { saeonInSetup, staffSaeon } from "./universe";

/** The first of next month in Seoul (the hero's 직책 reservation, E2 다음 일정). */
function nextMonthFirst() {
  const [y, m] = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 7).split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

// Mockup parity (employee-ux/final): the employee screens in the mockups' states, built from an empty database
// through the product, at 1440×900 · device scale 2. One journey, so each frame reuses what the earlier ones made.
test.use({ ...parityUse, actionTimeout: 20_000 });
test.skip(!PARITY_OUT, "set PARITY_OUT to capture");

test("employee screens in the mockup states", async ({ browser }) => {
  test.setTimeout(600_000);
  const { admin: a } = await saeonInSetup(browser);
  await go(a, "/people");
  await expect(a.getByRole("heading", { name: "아직 직원이 없습니다" })).toBeVisible();
  await shot(a, "E12-first-run");
  await staffSaeon(a);
  await heroHistory(a, nextMonthFirst());
  await rosterFrames(a);
  await startOperations(a);
  await cardFrames(a);
  await sheetFrames(a);
});
