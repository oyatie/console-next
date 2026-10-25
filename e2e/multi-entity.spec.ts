import { expect, test } from "@playwright/test";
import { fmtDate } from "@console/i18n/format";
import { expectAccessible } from "./a11y";
import { tenantOnboardSubmit, tenantSlugField, firstSignIn, go, kstDate, option, takeCode, unique, vendorPage } from "./flows";
import { addDepartments } from "./structure-flows";
import { firstWorkplace, registerAt } from "./helpers/entity";
import { registerEntity, SECOND, setupRail, startOperations, REGISTRATION_FIXTURES, brnDisplay } from "./setup-flows";

// One tenant, two 법인 (a group): each has its own registration, workplace and people, and every person is placed
// by id at one 법인 and one of its 사업장. Needs the backend's entity crate (branch hard/entity-depth, not merged).

test("a group of two legal entities: each with its workplace and people, placed by id", { tag: "@first-run" }, async ({ browser }) => {
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  await v.getByLabel("고객 이름").fill("가나그룹");
  await tenantSlugField(v).fill(unique("ganagroup"));
  await tenantOnboardSubmit(v).click();
  const admin = await firstSignIn(browser, await takeCode(v));

  await setupRail(admin).getByRole("link", { name: "법인 등록" }).first().click();
  await registerEntity(admin, "가나홀딩스");
  await firstWorkplace(admin, "가나홀딩스", "본사");
  // The second 법인: its own 사업자등록번호 and 법인등록번호.
  await go(admin, "/org/entities/new");
  await registerEntity(admin, "가나랩", false, undefined, SECOND);
  await firstWorkplace(admin, "가나랩", "연구소");

  await go(admin, "/org/entities");
  const list = admin.getByRole("grid", { name: "법인 목록" });
  for (const column of ["법인명", "구분", "대표 등록번호", "사업장", "재직", "확인"])
    await expect(list.getByRole("columnheader", { name: column, exact: true })).toBeVisible();
  await expect(list.getByRole("row", { name: new RegExp(`주식회사 가나홀딩스 .*${brnDisplay(REGISTRATION_FIXTURES.primary.brn)} 1곳`) })).toBeVisible();
  await expect(list.getByRole("row", { name: new RegExp(`주식회사 가나랩 .*${brnDisplay(REGISTRATION_FIXTURES.second.brn)} 1곳`) })).toBeVisible();
  await expectAccessible(admin, "entity list (two entities)");

  // A dated change, twice: each save carries the revision it read, so the second one is not refused as stale.
  await list.getByRole("row", { name: /주식회사 가나랩/ }).click();
  await expect(admin.getByRole("heading", { name: /가나랩/, level: 1 })).toBeVisible();
  for (const phone of ["02-1234-5678", "02-8765-4321"]) {
    await admin.getByRole("button", { name: "대표전화 수정" }).click();
    const edit = admin.getByRole("dialog", { name: "대표전화 수정" });
    await option(admin, "무엇을 기록합니까", "대표전화가 바뀌었습니다 · 변경").click();
    await option(admin, "언제부터 바뀝니까", `오늘 (${fmtDate(kstDate())})`).click();
    await edit.getByRole("textbox", { name: /^대표전화/ }).fill(phone);
    await edit.getByRole("button", { name: "변경 기록" }).click();
    await expect(edit).toBeHidden();
    await expect(admin.getByText(phone, { exact: true }).first()).toBeVisible();
  }

  await go(admin, "/org");
  for (const [place, unit] of [["본사", "경영지원팀"], ["연구소", "연구팀"]] as const) await addDepartments(admin, place, [unit]);
  await expectAccessible(admin, "setup org (two entities)");

  await registerAt(admin, "김지원", "가나홀딩스", "경영지원");
  // The head's 소속 (the placement history beside it links the same place under the same name).
  const head = admin.getByRole("group", { name: "소속", exact: true });
  await expect(head.getByRole("link", { name: "본사" })).toBeVisible();
  const researcher = await registerAt(admin, "박연구", "가나랩", "연구팀");
  await expect(head.getByRole("link", { name: "연구소" })).toBeVisible();

  // Each entity counts its own people.
  await go(admin, "/org/entities");
  await expect(list.getByRole("row", { name: /가나홀딩스 .* 1명/ })).toBeVisible();
  await expect(list.getByRole("row", { name: /가나랩 .* 1명/ })).toBeVisible();

  // The newest bearer the app itself sent (memory only). Nothing re-reads on a timer (decision #27), so the next
  // screen may well send no request at all: track every request from here instead of waiting for the next one.
  let bearer = "";
  admin.on("request", (r) => {
    const h = r.headers()["authorization"];
    if (h && r.url().includes("/api/v1/")) bearer = h;
  });
  await startOperations(admin);

  // 전적 cannot happen by accident through the placement path: a change of 법인 is refused with its remedy.
  await go(admin, "/org/entities");
  const headers = { authorization: bearer };
  const entities = (await (await admin.request.get("/api/v1/legal-entities", { headers })).json()) as { items: { id: string; current?: { name: string }; workplaces: { id: string }[] }[] };
  const holdings = entities.items.find((e) => e.current?.name === "주식회사 가나홀딩스")!;
  const moved = await admin.request.post("/api/v1/employment-assignments", {
    headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
    data: { employee_id: researcher, legal_entity_id: holdings.id, workplace_id: holdings.workplaces[0]!.id, valid_from: kstDate(1) },
  });
  expect(moved.status()).toBe(409);
  const refused = (await moved.json()) as { error: { code: string; reasons?: string[] } };
  expect(refused.error.code).toBe("entity_change_needs_group_transfer");
  expect(refused.error.reasons).toContain("start_group_transfer");
});

// 전근 (a move between 사업장 of one 법인, design §3.9): a lifecycle TRANSFER with to_workplace_id that splits the
// placement on its date and starts the 피보험자 전근 신고 clock when the workplaces' insurance links differ.
// Waits for hr's lifecycle TRANSFER to call the placement port (hr.rs, INTEG R2).
test.fixme("a transfer between two workplaces of one legal entity moves the placement on its date", async () => {});

// 전적 (a move between 법인) with consent and a continuity choice: group-transfer.spec.ts.
