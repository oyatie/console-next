import { expect, test } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { go } from "../flows";
import { tenantInSetup } from "../setup-flows";
import { chooseWorkbook, payPeriod } from "../helpers/import";
import { plain, workbook } from "../helpers/import-layouts";
import { apiOf, bearerOf, codeOf } from "../helpers/api";

// 이관 확인 (spec E7-reconcile, E7-row, E7-signoff; BE-EMP-UI §5) after an applied import, from an empty company: the
// sheet's funnel and the placement against the console, rows marked 맞음 / 다름 (Y/N), the honest sign-off with a row
// still open, and every guard the server keeps: a run not applied, a stale row mark, a sign-off whose count moved or
// that hides open rows, and any mark after the sign-off.

test("migration check: funnels, rows marked, an honest sign-off; stale, unacknowledged and late writes refused", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin } = await tenantInSetup(browser, "reconco", "대조상사", false, "대조 본점");
  const api = apiOf(admin, bearerOf(admin));
  const rows = ["하나", "두나", "세나"].map((name, i) => ({ number: `RC-000${i + 1}`, name: `${name}`, position: "사원", hired: "2020-03-02" }));
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "인사기록.xlsx", await workbook([plain("본사", rows)]));
  await payPeriod(admin);
  const previewed = admin.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/import/preview"));
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  const runId = ((await (await previewed).json()) as { run_id: string }).run_id;
  // Not applied yet: there is nothing to check.
  const early = await api(`/employees/import/${runId}/reconcile`);
  expect([early.status(), await codeOf(early)]).toEqual([409, "import_not_applied"]);
  await admin.getByRole("button", { name: "모의 반영 실행" }).click();
  await admin.getByRole("button", { name: "명부 반영: 신규 3명 · 갱신 0명" }).click();
  await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });

  const check = admin.getByRole("region", { name: "이관 확인" });
  await expect(check.getByRole("table", { name: "시트별 흐름" }).getByRole("row", { name: /본사/ })).toContainText("3");
  await expect(check.getByRole("table", { name: "배치 대조" })).toContainText("합계");
  const rowsGrid = check.getByRole("grid", { name: /^행별 대조/ });
  await expect(rowsGrid.getByRole("row")).toHaveCount(4);
  await expectAccessible(admin, "E7-reconcile");
  // @regression: the check was one flat column with its lines on the card edge; the sign-off card now sits beside it.
  const funnels = (await check.getByRole("table", { name: "시트별 흐름" }).boundingBox())!;
  const sign = (await check.getByRole("heading", { name: "이관 확인", level: 2 }).boundingBox())!;
  expect(sign.x).toBeGreaterThan(funnels.x + funnels.width);

  // Row 1 matches (button); row 2 differs, said with what (N key); row 3 stays open.
  await check.getByRole("button", { name: "맞음", exact: true }).click();
  await expect(rowsGrid.getByRole("row", { name: /하나/ })).toContainText("맞음");
  await check.getByRole("textbox", { name: "다른 점" }).fill("직위가 다름");
  await check.getByRole("button", { name: "다름 · 다시 볼 것" }).click();
  await expect(rowsGrid.getByRole("row", { name: /두나/ })).toContainText("다름");
  // Someone else marks 세나 first (another HR person, here the API): the screen's own press on that row is refused as
  // stale (409 stale_revision), said in place, and the row reads what is there now.
  const now = ((await (await api(`/employees/import/${runId}/reconcile/rows`)).json()) as { items: { source_key: string; name: string; version: number }[] }).items;
  const se = now.find((r) => r.name === "세나")!;
  expect((await api(`/employees/import/${runId}/reconcile/rows/${encodeURIComponent(se.source_key)}`, "PUT", { state: "CONFIRMED", expected_version: se.version })).status()).toBe(200);
  await check.getByRole("button", { name: "맞음", exact: true }).click();
  await expect(check.getByRole("status").filter({ hasText: "다른 사람이 먼저 이 행을 표시했습니다" })).toBeVisible();
  await expect(rowsGrid.getByRole("row", { name: /세나/ })).toContainText("맞음");

  // The server's guards, each followed by a read that shows nothing moved.
  const listed = ((await (await api(`/employees/import/${runId}/reconcile/rows`)).json()) as { items: { source_key: string; name: string; version: number; state: string }[] }).items;
  const one = listed.find((r) => r.name === "하나")!;
  const stale = await api(`/employees/import/${runId}/reconcile/rows/${encodeURIComponent(one.source_key)}`, "PUT", { state: "NEEDS_CHECK", expected_version: one.version - 1 });
  expect([stale.status(), await codeOf(stale)]).toEqual([409, "stale_revision"]);
  const unack = await api(`/employees/import/${runId}/signoff`, "POST", { expected_open_count: 1 });
  expect([unack.status(), await codeOf(unack)]).toEqual([428, "import_signoff_ack_required"]);
  const moved = await api(`/employees/import/${runId}/signoff`, "POST", { expected_open_count: 0, acknowledge_open: true });
  expect([moved.status(), await codeOf(moved)]).toEqual([409, "import_reconcile_changed"]);
  const counts = async () => ((await (await api(`/employees/import/${runId}/reconcile`)).json()) as { counts: object; signoff: unknown }).counts;
  expect(await counts()).toEqual({ rows: 3, confirmed: 2, needs_check: 1, unchecked: 0 });

  // The honest sign-off: the open rows are named on the button and kept with the record.
  await check.getByRole("button", { name: "남은 1행이 있는 채로 확인 기록" }).click();
  await expect(check.getByRole("status").filter({ hasText: "확인을 남겼습니다" })).toContainText("맞음 2 · 다름 1 · 남음 0");
  await expect(check).toContainText("확인을 기록해 더는 변경하지 않습니다");
  await expectAccessible(admin, "E7-signoff");
  const late = await api(`/employees/import/${runId}/reconcile/rows/${encodeURIComponent(one.source_key)}`, "PUT", { state: "NEEDS_CHECK", expected_version: one.version });
  expect([late.status(), await codeOf(late)]).toEqual([409, "import_signed_off"]);
  expect(await counts()).toEqual({ rows: 3, confirmed: 2, needs_check: 1, unchecked: 0 });
});
