import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { tenantSlugField, firstSignIn, go, takeCode, unique, vendorPage } from "./flows";
import { firstWorkplace, registerAt } from "./helpers/entity";
import { reasonChip } from "./helpers/lifecycle";
import { registerEntity, SECOND, setupRail, startOperations } from "./setup-flows";
import { reasonBox, sheet, todayPreset } from "./sheet";
import { addDepartments } from "./structure-flows";
import { hrAct } from "./record";

// TR-33, regression for move walk M22 (decisions #30): a 전보 never crosses 법인. With two 법인 from an empty
// database, the transfer picker does not offer the other 법인's 부서, a request crafted with it is refused by the
// server (422 transfer_cross_entity, single and bulk) and shown in its own words with 「전적으로 ›」 opening the 전적 sheet,
// nothing is recorded, and a 부서 of the person's own 법인 still transfers from the same sheet.
type Body = Record<string, unknown>;
type Refusal = { error: { code: string; refusals?: Body[] } };

test("regression M22: a transfer never reaches another 법인's 부서 (TR-33)", { tag: ["@regression", "@hr"] }, async ({ browser }) => {
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  await v.getByLabel("고객 이름").fill("가나그룹");
  await tenantSlugField(v).fill(unique("tr33"));
  await v.getByRole("button", { name: "개설하고 코드 발급" }).click();
  const admin = await firstSignIn(browser, await takeCode(v));

  await setupRail(admin).getByRole("link", { name: "법인 등록" }).first().click();
  await registerEntity(admin, "가나홀딩스");
  await firstWorkplace(admin, "가나홀딩스", "본사");
  await go(admin, "/org/entities/new");
  await registerEntity(admin, "가나랩", false, undefined, SECOND);
  await firstWorkplace(admin, "가나랩", "연구소");
  await go(admin, "/org");
  await addDepartments(admin, "본사", ["인사팀", "기획실"]);
  await addDepartments(admin, "연구소", ["기획팀"]);
  const person = await registerAt(admin, "강전적", "가나홀딩스", "인사팀");
  // The newest bearer the app itself sent (memory only). Nothing re-reads on a timer (decision #27), so the next
  // screen may well send no request at all: track every request from here instead of waiting for the next one.
  let bearer = "";
  admin.on("request", (r) => {
    const h = r.headers()["authorization"];
    if (h && r.url().includes("/api/v1/")) bearer = h;
  });
  await startOperations(admin);

  await go(admin, `/people/${person}`);
  const headers = { authorization: bearer };
  const units = ((await (await admin.request.get("/api/v1/org-units", { headers })).json()) as { items: { id: string; name: string }[] }).items;
  const theirs = units.find((u) => u.name === "기획팀")!.id;

  // The picker offers 기획실 (가나홀딩스) and never 기획팀 (가나랩), and says why.
  await hrAct(admin, "전보");
  const transfer = sheet(admin, "강전적 전보");
  await transfer.getByRole("combobox", { name: "어디로" }).fill("기획");
  await expect(admin.getByRole("option", { name: /기획실/ })).toBeVisible();
  await expect(admin.getByRole("option", { name: /기획팀/ })).toHaveCount(0);
  await expect(transfer).not.toContainText("다른 법인의 조직은 보이지 않습니다 · 법인 간 이동은 전적으로 합니다");
  await expectAccessible(admin, "TR-33: transfer picker without the other 법인's 부서");

  // On the wire, the choice is swapped for 가나랩's 기획팀: the server refuses it and the sheet says so.
  let crafted: Body = {};
  await admin.route(/\/api\/v1\/employees\/[^/]+\/lifecycle-events$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    crafted = { ...(route.request().postDataJSON() as Body), to_org_unit_id: theirs };
    await route.continue({ postData: JSON.stringify(crafted) });
  });
  await admin.getByRole("option", { name: /기획실/ }).click();
  await todayPreset(transfer).click();
  await reasonChip(transfer, "업무 필요").click();
  await reasonBox(transfer).fill("그룹 내 전적");
  await transfer.getByRole("button", { name: "전보 1명 반영", exact: true }).click();
  const refused = transfer.getByRole("alert");
  await expect(refused).toContainText("다른 법인으로는 전보할 수 없습니다 · 법인 간 이동은 전적으로 합니다");
  await expect(refused).toContainText("기획팀은 주식회사 가나랩 소속입니다");
  // The way to the other 법인 is the 전적 sheet itself (decisions #30), never a dead link.
  await expect(refused.getByRole("button", { name: "전적으로 ›" })).toBeEnabled();
  await expectAccessible(admin, "TR-33: cross-법인 transfer refused");
  await admin.unrouteAll();

  // The same request straight to the API, single and bulk: the typed 422 naming the target; nothing recorded.
  const post = (url: string, data: Body) => admin.request.post(url, { headers: { ...headers, "Idempotency-Key": crypto.randomUUID() }, data });
  const single = await post(`/api/v1/employees/${person}/lifecycle-events`, crafted);
  expect(single.status()).toBe(422);
  const one = (await single.json()) as Refusal;
  expect(one.error.code).toBe("transfer_cross_entity");
  expect(one.error.refusals?.[0]).toMatchObject({ field: "to_org_unit_id", value: theirs });
  const { effective_date, reason_code } = crafted;
  const bulk = await post("/api/v1/employees/lifecycle-events/bulk", { event_type: "TRANSFER", employee_ids: [person], to_org_unit_id: theirs, effective_date, reason_code, comment: "TR-33" });
  expect(bulk.status()).toBe(422);
  expect(((await bulk.json()) as Refusal).error.refusals?.[0]).toMatchObject({ employee_id: person, code: "transfer_cross_entity", field: "to_org_unit_id" });
  const events = (await (await admin.request.get(`/api/v1/employees/${person}/lifecycle-events`, { headers })).json()) as { items: { event_type: string }[] };
  expect(events.items.filter((e) => e.event_type === "TRANSFER")).toHaveLength(0);

  // A 부서 of 가나홀딩스 still transfers from the same sheet.
  await transfer.getByRole("button", { name: "전보 1명 반영", exact: true }).click();
  const history = admin.getByRole("region", { name: "인사 이력" });
  await expect(history.getByRole("listitem").filter({ hasText: /강전적을 인사팀에서 기획실로 전보했습니다/ })).toBeVisible();
});
