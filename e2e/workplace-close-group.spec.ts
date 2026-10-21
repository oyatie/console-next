import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { chooseRadio, go, kstDate } from "./flows";
import { hire, openClose } from "./helpers/close";
import { firstWorkplace } from "./helpers/entity";
import { addDepts } from "./helpers/structure";
import { openTenant } from "./helpers/tenant";
import { registerBranch, registerEntity, SECOND, startOperations, tenantInSetup } from "./setup-flows";

// Decision #30 in a 사업장 close (LC-F4): someone whose move crosses 법인 is offered 전적 instead of a refusal. Their line
// carries their own consent and 퇴직금 · 연차 · 근속 choices; the plan records the 전적 with the sending 법인's settlement,
// and the close applies. Refused, writing nothing: a 전근 to another 법인 (transfer_cross_entity), a 전적 without its facts
// (validation) or naming another 사업장 than the unit's (org_unit_at_other_workplace), and another tenant (404). A planner
// whose grant stops at the sending 법인 is refused for the receiving place (403 out_of_scope): proven in the HR adapter
// suite (tests/close_plan/group.rs), since no grant the 권한 screens make holds 법인 관리 for one 법인 only.

type View = { people: { employee_id: string }[]; units: { org_unit_id: string }[]; job?: { state: string } | null };
type Entities = { items: { id: string; current?: { name: string }; workplaces: { id: string; current?: { name: string } }[] }[] };
type Refused = { error: { code: string; refusals?: { employee_id?: string; code: string }[] } };

/** The newest bearer the app itself sent (memory only; nothing re-reads on a timer, decision #27). */
function bearerOf(page: Page) {
  let bearer = "";
  page.on("request", (r) => {
    const h = r.headers()["authorization"];
    if (h && r.url().includes("/api/v1/")) bearer = h;
  });
  return () => ({ authorization: bearer });
}

/** Picks `choice` in the plan SelectField labelled `label`. */
async function plan(page: Page, scope: ReturnType<Page["getByRole"]>, label: string, choice: string) {
  await scope.getByRole("button", { name: new RegExp(`${label}$`) }).click();
  await page.getByRole("option", { name: new RegExp(`^${choice}`) }).click();
}

test("closing a 사업장 moves a person to another 법인 by 전적 with their consent; what cannot be a 전적 is refused", { tag: ["@regression", "@org", "@hr"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin } = await tenantInSetup(browser, "wpclosegt", "누리", false, "본사");
  const headers = bearerOf(admin);
  await addDepts(admin, "본사", ["인사팀"]);
  await registerBranch(admin, "누리", "판교지점", "0008512347");
  await addDepts(admin, "판교지점", ["개발팀"]);
  await go(admin, "/org/entities/new");
  await registerEntity(admin, "가온", false, undefined, SECOND);
  await firstWorkplace(admin, "가온", "연구소");
  await addDepts(admin, "연구소", ["기획팀"]);
  const hired = kstDate(-200);
  await hire(admin, "김전적", "개발팀", "판교지점", hired);
  await startOperations(admin);

  // On the wire, nothing written by any refusal.
  await go(admin, "/org/entities");
  await expect.poll(() => headers().authorization).not.toBe("");
  const entities = ((await (await admin.request.get("/api/v1/legal-entities", { headers: headers() })).json()) as Entities).items;
  const site = (name: string) => entities.flatMap((e) => e.workplaces).find((w) => w.current?.name === name)!.id;
  const [branch, lab, hq] = [site("판교지점"), site("연구소"), site("본사")];
  const path = `/api/v1/workplaces/${branch}/close-plan`;
  const read = async () => (await (await admin.request.get(path, { headers: headers() })).json()) as View;
  const post = (h: Record<string, string>, data: object) => admin.request.post(path, { headers: { ...h, "Idempotency-Key": crypto.randomUUID() }, data });
  const before = await read();
  const person = before.people[0]!.employee_id;
  const dev = before.units[0]!.org_unit_id;
  const labView = (await (await admin.request.get(`/api/v1/workplaces/${lab}/close-plan`, { headers: headers() })).json()) as View;
  const planning = labView.units[0]!.org_unit_id;
  const facts = {
    continuity: "SETTLED", annual_leave_continuity: "SETTLED", seniority_continuity: "RESTART",
    group_service_start_date: hired, consent_date: kstDate(), consent_evidence_ref: "전적 동의서 (김전적 서명본)",
  };
  const line = (x: object) => ({ closed_on: kstDate(), units: [{ org_unit_id: dev, action: "DISSOLVE" }], people: [{ employee_id: person, ...x }] });
  const refused = async (data: object, want: string) => {
    const r = await post(headers(), data);
    expect(r.status()).toBe(422);
    const body = (await r.json()) as Refused;
    expect(body.error.refusals).toContainEqual(expect.objectContaining({ employee_id: person, code: want }));
  };
  await refused(line({ action: "TRANSFER", to_org_unit_id: planning }), "transfer_cross_entity");
  await refused(line({ action: "GROUP_TRANSFER", to_org_unit_id: planning, to_workplace_id: lab }), "validation");
  await refused(line({ action: "GROUP_TRANSFER", to_org_unit_id: planning, to_workplace_id: hq, group_transfer: facts }), "org_unit_at_other_workplace");

  // Another tenant does not find the 사업장 (404), and nothing was written by any of these.
  const stranger = await openTenant(browser, "wpclosegt-other", "다른그룹");
  const theirs = bearerOf(stranger);
  await go(stranger, "/org");
  await expect.poll(() => theirs().authorization).not.toBe("");
  const foreign = await stranger.request.post(path, { headers: { ...theirs(), "Idempotency-Key": crypto.randomUUID() }, data: line({ action: "GROUP_TRANSFER", to_org_unit_id: planning, to_workplace_id: lab, group_transfer: facts }) });
  expect(foreign.status()).toBe(404);
  const after = await read();
  expect(after.people.map((x) => x.employee_id)).toEqual([person]);
  expect(after.job ?? null).toBeNull();

  // The sheet: 개발팀 폐지, and 김전적 to 가온 › 기획팀 by 전적 with their consent and choices.
  const s = await openClose(admin, "판교지점");
  await s.getByRole("textbox", { name: /^폐쇄일/ }).fill(kstDate());
  await plan(admin, s, "개발팀 계획", "폐지");
  await plan(admin, s, "김전적 계획", "다른 법인으로 전적");
  const g = admin.getByRole("dialog", { name: "김전적님 전적" });
  await g.getByRole("button", { name: "확인" }).click();
  await expect(g.getByText("퇴직금을 정산할지 승계할지 선택하십시오")).toBeVisible();
  await g.getByRole("button", { name: /받을 법인$/ }).click();
  await admin.getByRole("option", { name: /가온/ }).click();
  await g.getByRole("button", { name: "김전적이 갈 사업장 · 부서" }).click();
  await admin.getByRole("dialog", { name: "김전적이 갈 사업장 · 부서" }).getByRole("row", { name: /^기획팀/ }).click();
  await g.getByLabel(/^동의 증빙/).fill("전적 동의서 (김전적 서명본)");
  await g.getByLabel(/^동의일/).fill(kstDate());
  await chooseRadio(g, /^퇴직금 지급/);
  await chooseRadio(g, /^남은 연차 수당 지급/);
  await chooseRadio(g, /^새 법인 근속은/);
  await g.getByLabel(/^그룹 입사일/).fill(hired);
  await expectAccessible(admin, "workplace close: a person's group transfer");
  await g.getByRole("button", { name: "확인" }).click();
  await expect(g).toBeHidden();
  await expect(s).toContainText("다른 법인으로 전적 1명");
  await expectAccessible(admin, "workplace close: plan with a group transfer");
  await s.getByRole("button", { name: "판교지점 폐쇄" }).click();
  await expect(s.getByRole("status").filter({ hasText: /닫힘/ })).toBeVisible();
  await expect(s).toContainText("전적 1명");

  // Recorded as one 전적: the person works at 가온, and 누리's settlement opened with it.
  type Events = { items: { event_type: string; state: string; group_transfer?: { settlement_case_id?: string } }[] };
  const events = ((await (await admin.request.get(`/api/v1/employees/${person}/lifecycle-events`, { headers: headers() })).json()) as Events).items;
  const moved = events.filter((x) => x.event_type === "GROUP_TRANSFER");
  expect(moved).toHaveLength(1);
  expect(moved[0]!.state).toBe("APPLIED");
  const caseId = moved[0]!.group_transfer!.settlement_case_id!;
  const settlement = (await (await admin.request.get(`/api/v1/hr/exit-cases/${caseId}`, { headers: headers() })).json()) as { status: string; exit_reason_code: string };
  expect(settlement).toMatchObject({ status: "HR_CONFIRMED", exit_reason_code: "GROUP_TRANSFER" });
  await go(admin, `/people/${person}`);
  await expect(admin.getByRole("group", { name: "소속", exact: true }).getByRole("link", { name: "주식회사 가온" })).toBeVisible();
});
