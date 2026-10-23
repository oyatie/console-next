import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { inviteAccount, grantAccess } from "./access-flows";
import { chooseRadio, firstSignIn, go, kstDate } from "./flows";
import { firstWorkplace } from "./helpers/entity";
import { fillRegister, openRegistered, pressRegister, receiptOf } from "./helpers/register";
import { openTenant } from "./helpers/tenant";
import { hrAct, openHistory } from "./record";
import { reasonBox, todayPreset } from "./sheet";
import { registerEntity, registerWorkplace, SECOND, setupRail, startOperations } from "./setup-flows";
import { addDepartments } from "./structure-flows";

// 전적 (decisions #30): 퇴직 at one 법인 and 채용 at another as one act, with the employee's consent (「민법」 제657조제1항)
// and 퇴직금 · 연차 · 근속 each chosen, none preselected. From an empty database: the sheet says why there is nowhere to go
// and offers the way on (no other 법인 → 법인 등록; a 법인 without 사업장 → 사업장 추가), then records the 전적 and the card,
// history and placement follow, and the sending 법인's settlement (퇴직금 · 금품청산) opens with its statutory deadlines,
// going back only with the 전적. Refusals: a 사업장 of the person's own 법인 (422, typed panel), another tenant (404, on the
// event and the settlement), the settlement's own reject (409), and a holder scoped to the sending 법인 (no receiving 법인
// offered; 403 out_of_scope on the wire) — none writes anything.
type Body = Record<string, unknown>;
type Entities = { items: { id: string; current?: { name: string }; workplaces: { id: string }[] }[] };
type Events = {
  items: { id: string; event_type: string; state: string; group_transfer?: { continuity: string; annual_leave_continuity: string; seniority_continuity: string; settlement_case_id?: string; consent_evidence_ref?: string } }[];
};
type ExitCase = { status: string; exit_reason_code?: string; next_actions: { key: string }[]; settlement_deadlines?: { kind: string; due_date: string | null; opens_on: string | null }[] };

/** The newest bearer the app itself sent (memory only; nothing re-reads on a timer, decision #27). */
function bearerOf(page: Page) {
  let bearer = "";
  page.on("request", (r) => {
    const h = r.headers()["authorization"];
    if (h && r.url().includes("/api/v1/")) bearer = h;
  });
  return () => ({ authorization: bearer });
}

/** Registers `name` at `unit`, hired `hired`, and lands on their record; returns their id. */
async function hire(admin: Page, name: string, unit: string, hired: string) {
  await go(admin, "/people/new");
  await fillRegister(admin, { name, unit, hired });
  await pressRegister(admin);
  await expect(receiptOf(admin, name)).toBeVisible();
  await openRegistered(admin, name);
  return new URL(admin.url()).pathname.split("/").pop()!;
}

const groupSheet = (page: Page) => page.getByRole("dialog", { name: "전적", exact: true });

test("전적: nowhere to go says why, then one act records the exit and the hire with consent and continuity", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await openTenant(browser, "gtransfer", "가나그룹");
  const headers = bearerOf(admin);
  await setupRail(admin).getByRole("link", { name: "법인 등록" }).first().click();
  await registerEntity(admin, "가나홀딩스");
  await firstWorkplace(admin, "가나홀딩스", "본사");
  await go(admin, "/org");
  await addDepartments(admin, "본사", ["인사팀"]);
  const hired = kstDate(-30);
  const person = await hire(admin, "강전적", "인사팀", hired);

  // One 법인: no dead end — register the receiving 법인, or stay inside this one (전보 · 전근).
  await hrAct(admin, "전적");
  const g = groupSheet(admin);
  await expect(g).toContainText("전적할 다른 법인이 없습니다");
  await expect(g.getByRole("link", { name: "법인 등록" })).toHaveAttribute("href", "/org/entities/new");
  await expect(g.getByRole("button", { name: "같은 법인 안이면 전보 · 전근" })).toBeVisible();
  await expectAccessible(admin, "group transfer: solo tenant");
  await g.getByRole("link", { name: "법인 등록" }).click();
  await registerEntity(admin, "가나랩", false, undefined, SECOND);

  // A second 법인 with no 사업장: the sheet names it and adds one from there.
  await go(admin, `/people/${person}`);
  await hrAct(admin, "전적");
  await expect(g).toContainText("받을 법인에 열린 사업장이 없습니다");
  await g.getByRole("link", { name: "주식회사 가나랩에 사업장 추가" }).click();
  await registerWorkplace(admin, "가나랩", "연구소");
  await addDepartments(admin, "연구소", ["기획팀"]);
  await startOperations(admin);

  // The act: nothing is preselected; a bare submit names what is missing.
  await go(admin, `/people/${person}`);
  await hrAct(admin, "전적");
  await expect(g).toContainText("주식회사 가나홀딩스에서 퇴직하고 받을 법인에 채용합니다(전적)");
  await g.getByRole("button", { name: "전적 1명 예약", exact: true }).click();
  await expect(g.getByText("동의 증빙을 입력하십시오")).toBeVisible();
  await expect(g.getByText("퇴직금을 정산할지 승계할지 선택하십시오")).toBeVisible();
  await expect(g.getByText("남은 연차를 수당으로 지급할지 넘길지 선택하십시오")).toBeVisible();
  await expect(g.getByText("근속을 새로 셀지 이어 셀지 선택하십시오")).toBeVisible();
  await expect(g.getByText("받을 법인의 사업장이나 부서를 선택하십시오")).toBeVisible();
  await g.getByLabel(/^동의 증빙/).fill("전적 동의서 (강전적 서명본)");
  await g.getByLabel(/^동의일/).fill(kstDate(-1));
  await g.getByRole("combobox", { name: "어느 법인으로" }).fill("기획");
  await expect(admin.getByRole("option", { name: /인사팀/ })).toHaveCount(0);
  await admin.getByRole("option", { name: /기획팀/ }).click();
  await todayPreset(g).click();
  // Each dimension is its own choice; any one carried asks for the agreement, all settled does not.
  await chooseRadio(g, /^근속 이어 셈/);
  await expect(g.getByLabel(/^승계 합의서/)).toBeVisible();
  await chooseRadio(g, /^새 법인 근속은/);
  await chooseRadio(g, /^승계 · 합의서 붙임/);
  await expect(g.getByLabel(/^승계 합의서/)).toBeVisible();
  await chooseRadio(g, /^퇴직금 지급/);
  await chooseRadio(g, /^남은 연차 수당 지급/);
  await expect(g.getByLabel(/^승계 합의서/)).toHaveCount(0);
  await g.getByRole("button", { name: /^입사일과 같게/ }).click();
  await reasonBox(g).fill("그룹 내 연구 조직 강화");
  const preview = g.getByRole("region", { name: "법인별로 기록되는 것" });
  await expect(preview).toContainText("주식회사 가나홀딩스 · 퇴직");
  await expect(preview).toContainText("주식회사 가나랩 · 채용");
  await expect(preview).toContainText("주식회사 가나홀딩스에서 지급 · 퇴직 정산 처리가 열립니다");
  await expect(preview).toContainText("주식회사 가나홀딩스에서 남은 연차 수당 지급");
  await expectAccessible(admin, "group transfer: filled sheet");
  await g.getByRole("button", { name: "전적 1명 반영", exact: true }).click();
  await expect(g).toBeHidden();

  // The card follows: the 법인 row, the history line with its facts.
  await expect(admin.getByRole("group", { name: "소속", exact: true }).getByRole("link", { name: "주식회사 가나랩" })).toBeVisible();
  await openHistory(admin);
  const history = admin.getByRole("region", { name: "인사 이력" });
  await expect(history.getByText(/주식회사 가나랩으로 전적했습니다/)).toBeVisible();
  await expect(history).toContainText("퇴직금·연차는 보내는 법인에서 정산");

  // The sending 법인's settlement opened with it: linked from the receipt, its deadlines from the statutory register
  // (open from the 퇴직일, due D-n), moving forward only — the way back is the 전적's own, from the history.
  await admin.getByRole("link", { name: /퇴직 정산 열기$/ }).click();
  await expect(admin.getByRole("heading", { level: 1 })).toContainText("강전적");
  const deadlines = admin.getByRole("region", { name: "정산 기한" });
  await expect(deadlines).toContainText("금품청산");
  await expect(deadlines).toContainText("퇴직금 지급");
  await expect(deadlines).toContainText("「근로기준법」 제36조");
  await expect(deadlines).toContainText("「근로자퇴직급여 보장법」 제9조제1항");
  await expect(deadlines).toContainText(/D-\d+|오늘까지/);
  await expect(admin.getByRole("button", { name: /^퇴직 (반려|보고 취소)$/ })).toHaveCount(0);
  await expect(admin.getByRole("link", { name: "인사 이력에서 전적 철회" })).toBeVisible();
  await expectAccessible(admin, "group transfer: the sending entity's settlement");
  const settlementUrl = admin.url();
  await go(admin, `/people/${person}`);

  // On the wire: the facts as recorded, and each refusal writes nothing.
  const api = (path: string, data?: Body, h = headers()) =>
    data ? admin.request.post(path, { headers: { ...h, "Idempotency-Key": crypto.randomUUID() }, data }) : admin.request.get(path, { headers: h });
  const events = async () => ((await (await api(`/api/v1/employees/${person}/lifecycle-events`)).json()) as Events).items;
  const group = (await events()).filter((x) => x.event_type === "GROUP_TRANSFER");
  expect(group).toHaveLength(1);
  expect(group[0]).toMatchObject({ state: "APPLIED", group_transfer: { continuity: "SETTLED", annual_leave_continuity: "SETTLED", seniority_continuity: "RESTART" } });
  const caseId = group[0]!.group_transfer!.settlement_case_id!;
  expect(settlementUrl).toContain(caseId);
  const settlement = async () => (await (await api(`/api/v1/hr/exit-cases/${caseId}`)).json()) as ExitCase;
  const opened = await settlement();
  expect(opened).toMatchObject({ status: "HR_CONFIRMED", exit_reason_code: "GROUP_TRANSFER" });
  expect(opened.next_actions.map((a) => a.key)).not.toContain("reject_exit");
  expect(opened.settlement_deadlines?.map((d) => d.kind)).toEqual(["FINAL_PAY", "SEVERANCE_PAY"]);
  expect(opened.settlement_deadlines?.every((d) => d.due_date && d.opens_on && d.opens_on <= d.due_date)).toBe(true);
  // Its own reject refuses: the 전적 is withdrawn from the history instead. Nothing changes.
  const reject = await api(`/api/v1/hr/exit-cases/${caseId}/reject`, { reason: "잘못 열림" });
  expect(reject.status()).toBe(409);
  expect(((await reject.json()) as { error: { code: string } }).error.code).toBe("exit_case_follows_group_transfer");
  expect((await settlement()).status).toBe("HR_CONFIRMED");
  const before = (await events()).length;
  const entities = ((await (await api("/api/v1/legal-entities")).json()) as Entities).items;
  const lab = entities.find((e) => e.current?.name === "주식회사 가나랩")!;
  const facts = { continuity: "SETTLED", group_service_start_date: hired, consent_date: kstDate(-1), consent_evidence_ref: "전적 동의서" };
  const body = { event_type: "GROUP_TRANSFER", effective_date: kstDate(), comment: "e2e", to_workplace_id: lab.workplaces[0]!.id, group_transfer: facts };
  const same = await api(`/api/v1/employees/${person}/lifecycle-events`, body);
  expect(same.status()).toBe(422);
  expect(((await same.json()) as { error: { code: string } }).error.code).toBe("group_transfer_same_entity");
  const stranger = await openTenant(browser, "gt-other", "다른그룹");
  const theirs = bearerOf(stranger);
  await go(stranger, "/people");
  await expect.poll(() => theirs().authorization).not.toBe("");
  const foreign = await stranger.request.post(`/api/v1/employees/${person}/lifecycle-events`, { headers: { ...theirs(), "Idempotency-Key": crypto.randomUUID() }, data: body });
  expect(foreign.status()).toBe(404);
  // Nor does another tenant see or close the settlement.
  expect((await stranger.request.get(`/api/v1/hr/exit-cases/${caseId}`, { headers: theirs() })).status()).toBe(404);
  const foreignReject = await stranger.request.post(`/api/v1/hr/exit-cases/${caseId}/reject`, { headers: theirs(), data: { reason: "x" } });
  expect([403, 404]).toContain(foreignReject.status());
  expect((await settlement()).status).toBe("HR_CONFIRMED");
  // Their screen says the same: no such record here, and nothing to act on.
  await go(stranger, `/people/${person}`);
  await expect(stranger.getByRole("heading", { name: "볼 권한이 없는 인사카드입니다", level: 1 })).toBeVisible();
  expect(await events()).toHaveLength(before);

  // The same refusal in the sheet: a stale choice of the person's own 법인 is refused in its own words, with the way on.
  await go(admin, `/people/${person}`);
  await hrAct(admin, "전적");
  await admin.route(/\/api\/v1\/employees\/[^/]+\/lifecycle-events$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const sent = route.request().postDataJSON() as Body;
    await route.continue({ postData: JSON.stringify({ ...sent, to_workplace_id: lab.workplaces[0]!.id, to_org_unit_id: undefined }) });
  });
  await g.getByLabel(/^동의 증빙/).fill("전적 동의서");
  await g.getByLabel(/^동의일/).fill(kstDate(-1));
  await g.getByRole("combobox", { name: "어느 법인으로" }).fill("인사");
  await admin.getByRole("option", { name: /인사팀/ }).click();
  await todayPreset(g).click();
  await chooseRadio(g, /^퇴직금 지급/);
  await chooseRadio(g, /^남은 연차 수당 지급/);
  await chooseRadio(g, /^새 법인 근속은/);
  await g.getByRole("button", { name: /^입사일과 같게/ }).click();
  await reasonBox(g).fill("복귀");
  await g.getByRole("button", { name: "전적 1명 반영", exact: true }).click();
  const refused = g.getByRole("alert");
  await expect(refused).toContainText("같은 법인 안으로는 전적하지 않습니다");
  await expect(refused).toContainText("기록한 것은 없습니다");
  await expect(refused.getByRole("button", { name: "같은 법인 안이면 전보 · 전근" })).toBeVisible();
  await expectAccessible(admin, "group transfer: refused, same legal entity");
  await admin.unrouteAll();
  expect(await events()).toHaveLength(before);

  // Rescinding the 전적 takes its open settlement with it.
  const rescind = await api(`/api/v1/employees/${person}/lifecycle-events/${group[0]!.id}/rescind`, { reason_code: "INPUT_ERROR", confirm_cascades: true });
  expect(rescind.status()).toBe(200);
  expect((await settlement()).status).toBe("CANCELLED");
});

test("전적 by a holder scoped to the sending 법인: no receiving 법인 is offered, and the wire refuses it", { tag: ["@hr", "@access", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await openTenant(browser, "gtscope", "늘봄그룹");
  const adminHeaders = bearerOf(admin);
  await setupRail(admin).getByRole("link", { name: "법인 등록" }).first().click();
  await registerEntity(admin, "늘봄정밀");
  await firstWorkplace(admin, "늘봄정밀", "본사");
  await go(admin, "/org/entities/new");
  await registerEntity(admin, "늘봄물류", false, undefined, SECOND);
  await firstWorkplace(admin, "늘봄물류", "물류센터");
  await go(admin, "/org");
  await addDepartments(admin, "본사", ["총무부"]);
  await addDepartments(admin, "물류센터", ["영업부"]);
  const person = await hire(admin, "박담당", "총무부", kstDate(-30));
  const code = await inviteAccount(admin, "김인사", "none");
  await grantAccess(admin, "김인사", "full", /주식회사 늘봄정밀/);
  await startOperations(admin);

  const hr = await firstSignIn(browser, code);
  const headers = bearerOf(hr);
  await go(hr, `/people/${person}`);
  await hrAct(hr, "전적");
  const g = groupSheet(hr);
  await expect(g).toContainText("권한 범위에 받을 법인이 없습니다");
  await expect(g.getByRole("link", { name: "내 권한 보기" })).toHaveAttribute("href", "/account");
  await expectAccessible(hr, "group transfer: scoped holder");

  const entities = ((await (await admin.request.get("/api/v1/legal-entities", { headers: adminHeaders() })).json()) as Entities).items;
  const other = entities.find((e) => e.current?.name === "주식회사 늘봄물류")!;
  const list = async () => ((await (await hr.request.get(`/api/v1/employees/${person}/lifecycle-events`, { headers: headers() })).json()) as Events).items.length;
  const before = await list();
  const refused = await hr.request.post(`/api/v1/employees/${person}/lifecycle-events`, {
    headers: { ...headers(), "Idempotency-Key": crypto.randomUUID() },
    data: {
      event_type: "GROUP_TRANSFER",
      effective_date: kstDate(),
      comment: "e2e",
      to_workplace_id: other.workplaces[0]!.id,
      group_transfer: { continuity: "SETTLED", group_service_start_date: kstDate(-30), consent_date: kstDate(-1), consent_evidence_ref: "전적 동의서" },
    },
  });
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("out_of_scope");
  expect(await list()).toBe(before);
});
