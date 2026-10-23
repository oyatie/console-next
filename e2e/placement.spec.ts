import { expect, test, type Page, type Request } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, kstDate, registerEmployee } from "./flows";
import { apiOf, bearerOf, codeOf, headcount } from "./helpers/api";
import { reasonChip } from "./helpers/lifecycle";
import { hrAct, openCard, openHistory } from "./record";
import { fillRegister, pressRegister, receiptOf, openRegistered, registerSheet } from "./helpers/register";
import { openUnit } from "./helpers/structure";
import { addDepartments } from "./structure-flows";
import { openTenant } from "./helpers/tenant";
import { registerBranch, registerEntity, registerWorkplace, SECOND, setupCompany, startOperations } from "./setup-flows";
import { reasonBox, sheet, todayPreset } from "./sheet";

// UX-R1 PLACEMENT (regression: org-01, move-02, move-01, move-21). A person's 사업장 and 법인 follow their 부서:
// registering from a 부서 places them at its 사업장, a 전보 into another 사업장's 부서 is a 전근, and a 전보 into
// another 법인's 부서 is refused (a 전적). Each refusal is proved at the server (status, code, nothing written)
// and on screen (the words that name the way forward, nothing changed). From an empty database, through the UI.

const CO = "삼한정밀";
const CO_B = "삼한솔루션";
const HIRED = kstDate(-30); // a 전보 today never lands on the day the placement starts
const SHOTS = process.env.PLACEMENT_SHOTS;

type Node = { kind: string; id: string; name: string; headcount: number; direct_headcount: number; children: Node[] };
type Entity = { id: string; current?: { name: string }; workplaces: { id: string; default_branch_id?: string | null; current?: { name: string } }[] };

const shot = (page: Page, name: string) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : Promise.resolve());

function find(nodes: Node[], name: string): Node {
  for (const n of nodes) {
    if (n.name === name) return n;
    const below = n.children.length ? findOrNull(n.children, name) : null;
    if (below) return below;
  }
  throw new Error(`no ${name} on the chart`);
}
const findOrNull = (nodes: Node[], name: string): Node | null => {
  try {
    return find(nodes, name);
  } catch {
    return null;
  }
};

/** Rewrites the JSON body of the next matching POST (a client that sends a stale or tampered choice); returns what it saw. */
async function tamperOnce(page: Page, url: RegExp, edit: (body: Record<string, unknown>) => void) {
  const seen: Record<string, unknown>[] = [];
  await page.route(url, async (route, req: Request) => {
    if (seen.length > 0 || req.method() !== "POST") return route.continue();
    const body = req.postDataJSON() as Record<string, unknown>;
    seen.push({ ...body });
    edit(body);
    await route.continue({ postData: JSON.stringify(body) });
  });
  return seen;
}

test("placement: 법인 · 사업장 follow the 부서, a 전근 moves them, a 전보 never crosses a 법인", { tag: "@first-run" }, async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const admin = await openTenant(browser, "placement", CO);
  const api = apiOf(admin, bearerOf(admin));
  await setupCompany(admin, CO, "본사");
  await registerBranch(admin, CO, "평택공장", "0008512347");
  await go(admin, "/org/entities/new");
  await registerEntity(admin, CO_B, false, undefined, SECOND);
  await admin.getByRole("button", { name: /^사업장 \d/ }).click();
  await admin.getByRole("link", { name: "사업장 추가" }).first().click();
  await registerWorkplace(admin, CO_B, "판교오피스");
  // The 부서 go on the chart (/setup/org redirects there since cs-chart).
  await go(admin, "/org");
  for (const [parent, units] of [["본사", ["인사팀", "영업팀"]], ["평택공장", ["생산팀"]], ["생산팀", ["조립파트"]], ["판교오피스", ["기획팀"]]] as const) await addDepartments(admin, parent, units);
  await startOperations(admin);

  const entities = ((await (await api("/legal-entities")).json()) as { items: Entity[] }).items;
  const a = entities.find((e) => e.current?.name === `주식회사 ${CO}`)!;
  const hq = a.workplaces.find((w) => w.current?.name === "본사")!;
  const chart = async () => ((await (await api("/org-structure")).json()) as { entities: Node[] }).entities;
  const unitId = async (name: string) => find(await chart(), name).id;

  await test.step("org-01: registering from 생산팀 places the person at 평택공장; a contradicting 사업장 is refused", async () => {
    await (await openUnit(admin, "생산팀")).getByRole("link", { name: "생산팀에 직원 등록" }).click();
    await fillRegister(admin, { name: "윤생산", hired: HIRED });
    const form = registerSheet(admin);
    // The 사업장 comes from the 부서: no free choice, and it names 평택공장.
    await expect(form.getByRole("radiogroup", { name: /^어느 사업장 소속입니까/ })).toHaveCount(0);
    await expect(form).toContainText("평택공장");
    // A client that sends 본사 anyway is refused with the way forward, and nothing is written.
    const before = await headcount(api);
    const sent = await tamperOnce(admin, /\/api\/v1\/employees$/, (b) => (b.workplace_id = hq.id));
    await pressRegister(admin);
    await expect(form.getByRole("alert")).toContainText("선택한 부서는 다른 사업장에 있습니다");
    await expectAccessible(admin, "register refused: 사업장 contradicts the 부서");
    await shot(admin, "org-01-register-refused");
    expect(await headcount(api)).toBe(before);
    // The server, directly, from a deeper 부서 (조립파트 › 생산팀 › 평택공장): 422, nothing written.
    const deep = await api("/employees", "POST", { ...sent[0], name: "직접등록", org_unit_id: await unitId("조립파트"), workplace_id: hq.id, idempotency_key: crypto.randomUUID() });
    expect([deep.status(), await codeOf(deep)]).toEqual([422, "org_unit_at_other_workplace"]);
    expect(await headcount(api)).toBe(before);
    // As sent by the form, it registers at 평택공장.
    await pressRegister(admin);
    await expect(receiptOf(admin, "윤생산")).toBeVisible();
    await openRegistered(admin, "윤생산");
    await expect(admin.getByRole("region", { name: "재직·배치" })).toContainText("평택공장");
    const branchCard = admin.getByRole("region", { name: "소속 지점" });
    await expect(branchCard).toContainText("현재 평택공장");
    await expect(branchCard.getByRole("radiogroup")).toHaveCount(0);
    await shot(admin, "org-01-record-after");
    const id = new URL(admin.url()).pathname.split("/").pop()!;
    // Binding them at 본사 afterwards is refused too (the hole the old two-call form used).
    const bind = await api("/employment-assignments", "POST", { employee_id: id, legal_entity_id: a.id, workplace_id: hq.id, valid_from: HIRED }, { "Idempotency-Key": crypto.randomUUID() });
    expect([bind.status(), await codeOf(bind)]).toEqual([422, "org_unit_at_other_workplace"]);
    // So is a one-click 소속 지점 that is not 평택공장's.
    const head = ((await (await api(`/employees/${id}`)).json()) as { employee: { updated_at: string } }).employee;
    const branch = await api(`/employees/${id}/home-branch`, "PUT", { branch_id: hq.default_branch_id, expected_updated_at: head.updated_at });
    expect([branch.status(), await codeOf(branch)]).toEqual([422, "home_branch_not_workplace"]);
    const after = await (await api(`/employment-assignments?employee_id=${id}`)).json();
    expect(JSON.stringify(after)).not.toContain(hq.id);
  });

  await test.step("move-02: a 전보 into 평택공장 › 생산팀 is a 전근; the 사업장 and the counts follow", async () => {
    await registerEmployee(admin, { name: "이전근", unit: "영업팀", hired: HIRED });
    await hrAct(admin, "전보");
    const s = sheet(admin, "이전근 전보");
    await s.getByRole("combobox", { name: "어디로" }).fill("생산");
    await admin.getByRole("option", { name: /생산팀/ }).first().click();
    await todayPreset(s).click();
    await reasonChip(s, "업무 필요").click();
    await reasonBox(s).fill("생산 지원");
    await s.getByRole("button", { name: "전보 1명 반영", exact: true }).click();
    await openHistory(admin);
    await expect(admin.getByRole("region", { name: "인사 이력" }).getByRole("listitem").filter({ hasText: /이전근을 영업팀에서 생산팀으로 전보했습니다/ })).toBeVisible();
    await openCard(admin);
    await expect(admin.getByRole("region", { name: "재직·배치" })).toContainText("평택공장");
    await shot(admin, "move-02-record-after");
    await expect(admin.getByRole("region", { name: "소속 지점" })).toContainText("현재 평택공장");
    await expect(admin.getByRole("region", { name: "소속 지점" }).getByRole("radiogroup")).toHaveCount(0);
  });

  await test.step("move-01: another 법인's 부서 is not offered, and a 전보 there is refused as a 전적", async () => {
    await registerEmployee(admin, { name: "강전적", unit: "인사팀", hired: HIRED });
    const id = new URL(admin.url()).pathname.split("/").pop()!;
    const profile = admin.getByRole("region", { name: "재직·배치" });
    await expect(profile).toContainText("본사 ·");
    // Settled first: "nothing changes" compares two loaded states, not a read still in flight.
    await expect(profile).not.toContainText("불러오는 중");
    const was = await profile.innerText();
    await hrAct(admin, "전보");
    const s = sheet(admin, "강전적 전보");
    const where = s.getByRole("combobox", { name: "어디로" });
    await where.fill("영업");
    await expect(admin.getByRole("option", { name: /영업팀/ }).first()).toBeVisible();
    await where.fill("기획");
    await expect(admin.getByRole("option", { name: /영업팀/ })).toHaveCount(0);
    await expect(admin.getByRole("option", { name: /기획팀/ })).toHaveCount(0);
    // A stale picker sends 법인 B's 기획팀 anyway: refused, named as a 전적, nothing changes.
    await where.fill("영업");
    await admin.getByRole("option", { name: /영업팀/ }).first().click();
    await todayPreset(s).click();
    await reasonChip(s, "업무 필요").click();
    await reasonBox(s).fill("판교 지원");
    const planning = await unitId("기획팀");
    const sent = await tamperOnce(admin, /\/lifecycle-events$/, (b) => (b.to_org_unit_id = planning));
    await s.getByRole("button", { name: "전보 1명 반영", exact: true }).click();
    await expect(s.getByRole("alert")).toContainText("전적");
    await expectAccessible(admin, "transfer refused: another 법인's 부서");
    await shot(admin, "move-01-transfer-refused");
    await s.getByRole("button", { name: "취소", exact: true }).click();
    expect(await profile.innerText()).toBe(was);
    // The server, directly: TR-33's 422 transfer_cross_entity (one code for a 전보 across 법인), and the record and its history are as they were.
    const events = async () => {
      const body = (await (await api(`/employees/${id}/lifecycle-events`)).json()) as unknown[] | { items?: unknown[]; data?: unknown[] };
      return Array.isArray(body) ? body.length : (body.items ?? body.data ?? []).length;
    };
    const n = await events();
    const direct = await api(`/employees/${id}/lifecycle-events`, "POST", { ...sent[0], to_org_unit_id: planning }, { "Idempotency-Key": crypto.randomUUID() });
    expect([direct.status(), await codeOf(direct)]).toEqual([422, "transfer_cross_entity"]);
    expect(await events()).toBe(n);
  });

  await test.step("move-21: the counts add up at every level", async () => {
    const tree = await chart();
    const sum = (n: Node): number => n.direct_headcount + n.children.reduce((t, c) => t + c.headcount, 0);
    for (const name of ["본사", "평택공장", "판교오피스", "생산팀"]) expect(find(tree, name).headcount, name).toBe(sum(find(tree, name)));
    expect([find(tree, "본사").headcount, find(tree, "평택공장").headcount, find(tree, "판교오피스").headcount]).toEqual([1, 2, 0]);
    await go(admin, "/org");
    await shot(admin, "move-21-chart-after");
  });
});
