import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { soloTenant } from "./chaos";
import { go, kstDate, registerEmployee } from "./flows";
import { addDepts, openUnit, sheet } from "./helpers/structure";
import { setupCompany, startOperations } from "./setup-flows";
import { box, leaveScreen, revealUnit } from "./structure-flows";
import { shot } from "./shots";

// UX-R3 STRUCT after go-live: org-15 one dissolve flow whichever door opens it (the 「삭제 · 폐지」 sheet hands a used
// department to the dated 폐지 sheet, never 「먼저 이동하십시오」); org-16 a department held by an open org change names that
// change, linked, as its one blocker; org-05 a 삭제 over several chosen departments names every one of them; org-22 after a
// change the chart keeps the boxes it had open and shows the result (a new 부서 under its parent).
// regression: on the parent the end sheet refused with the members, the hold was not named, and 삭제 took the first alone.

test("regression: one dissolve flow, a held unit names its change, and 삭제 over several names all of them (org-05, org-15, org-16)", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await soloTenant(browser, "uxr3-ends", "끝내기상사");
  const auth = new Promise<string>((resolve) => admin.on("request", (r) => r.headers()["authorization"] && r.url().includes("/api/v1/") && resolve(r.headers()["authorization"]!)));
  await setupCompany(admin, "끝내기상사", "본사");
  await go(admin, "/org");
  await addDepts(admin, "본사", ["재무팀", "품질팀", "연구1파트", "연구2파트"]);
  await registerEmployee(admin, { name: "한재무", number: "EN-0001", hired: "2024-03-04", unit: "재무팀" });
  await startOperations(admin);
  await go(admin, "/org");
  await leaveScreen(admin);
  const endSheetOf = async (name: string) => {
    await openUnit(admin, name);
    const u = new URL(admin.url());
    u.searchParams.set("act", "dept-delete");
    await go(admin, u.pathname + u.search);
    return u.searchParams.get("sel")!;
  };

  // org-15: the end sheet of a used department with a member hands over to the one 폐지 sheet that settles them.
  await endSheetOf("재무팀");
  await expect(sheet(admin, "재무팀 폐지")).toBeVisible();
  await expect(admin.getByText("먼저 이동하십시오")).toHaveCount(0);
  await admin.keyboard.press("Escape");

  // org-16: a scheduled rename holds 품질팀; its end sheet names that change, linked, and nothing else.
  const qa = await endSheetOf("품질팀");
  await admin.keyboard.press("Escape");
  const drafted = await admin.request.post("/api/v1/org-changes", {
    headers: { authorization: await auth, "Idempotency-Key": crypto.randomUUID() },
    data: { kind: "REORG", target: { kind: "ORG_UNIT", ref: qa, label: "품질팀 이름 변경" }, proposal: [{ op: "RENAME_ORG_UNIT", orgUnitId: qa, name: "품질보증팀" }], effectiveDate: kstDate(3), reason: "이름 정리" },
  });
  expect(drafted.status()).toBe(201);
  const code = (await drafted.json()).code as string;
  await admin.reload();
  await endSheetOf("품질팀");
  const held = sheet(admin, "품질팀 삭제 · 폐지");
  await expect(held).toContainText(`${code} 조직 변경이 이 부서를 다루고 있어`);
  await expect(held.getByRole("link", { name: `${code} 열기` })).toBeVisible();
  await expect(held).not.toContainText("구성원");
  await expectAccessible(admin, "end sheet: a held department names its change");
  await shot(admin, "after-org-16-held-names-change");
  await admin.keyboard.press("Escape");

  // org-05: two chosen, 삭제 names both, each with its own 폐지.
  await go(admin, "/org");
  await revealUnit(admin, "연구1파트");
  await box(admin, "연구2파트").click({ modifiers: ["Shift"] });
  await admin.getByRole("region", { name: "선택한 조직" }).getByRole("button", { name: "삭제" }).click();
  const many = admin.getByRole("dialog", { name: "부서 2개 폐지" });
  await expect(many.getByRole("button", { name: "연구1파트 폐지" })).toBeVisible();
  await expect(many.getByRole("button", { name: "연구2파트 폐지" })).toBeVisible();
  await expectAccessible(admin, "bulk 삭제 after go-live names every chosen department");
  await shot(admin, "after-org-05-bulk-names-all");
  await many.getByRole("button", { name: "연구2파트 폐지" }).click();
  await expect(sheet(admin, /연구2파트/)).toBeVisible();
});

test("regression: after a change the chart keeps its boxes and draws the result (org-22)", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const admin = await soloTenant(browser, "uxr3-reveal", "드러내기상사");
  await setupCompany(admin, "드러내기상사", "본사");
  await go(admin, "/org");
  await addDepts(admin, "본사", ["재무팀"]);
  await startOperations(admin);
  await go(admin, "/org");
  await leaveScreen(admin);

  // org-22: a new 부서 today under 재무팀; back on the chart it is drawn, under its parent, without opening anything.
  const fin = await openUnit(admin, "재무팀");
  await fin.getByRole("button", { name: "부서 추가" }).click();
  const add = sheet(admin, "부서 신설");
  await add.getByLabel("부서 이름").fill("결산파트");
  await add.getByRole("button", { name: /^오늘/ }).click();
  await add.getByLabel("사유").fill("결산 기능 분리");
  await add.getByRole("button", { name: "부서 신설 1개 반영" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "결산파트 신설을 반영했습니다" })).toBeVisible();
  await expect(box(admin, "결산파트")).toBeVisible();
  await shot(admin, "after-org-22-chart-shows-result");
});
