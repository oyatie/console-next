import { expect, type Browser, type Page, type Route } from "@playwright/test";
import { t } from "@console/i18n";
import { apiOf, bearerOf } from "./api";
import { cellOf, officeSchedule, openMonth, pastWorkDay } from "./attendance-records";
import { chooseRadio, go, kstDate, registerEmployee } from "../flows";
import { addDepartments } from "../structure-flows";
import { tenantBeforeSetup, tenantInSetup } from "../setup-flows";

export async function securityWorld(browser: Browser, slug: string, kind: "different-tenant" | "lower-grant") {
  const { admin, exec } = await tenantInSetup(browser, slug, "기록권한시험", false, "본사", "none");
  const homeBearer = bearerOf(admin);
  await go(admin, "/org");
  await addDepartments(admin, "본사", ["인사부"]);
  await registerEmployee(admin, { name: "윤하준", number: "S-1", hired: kstDate(-60) });
  await officeSchedule(admin);
  const token = homeBearer();
  const api = apiOf(admin, () => token);
  const people = (await (await api("/employees?limit=10")).json()) as { items: { id: string; name: string }[] };
  const person = people.items.find(p => p.name === "윤하준")!.id;
  const { month, date, other } = await pastWorkDay(api, person);
  const tree = (await (await api("/attendance/schedule/tree")).json()) as { nodes: { kind: string; id: string }[] };
  const workplace = tree.nodes.find(n => n.kind === "WORKPLACE")!.id;
  const grid = await openMonth(admin, month);
  await cellOf(admin, "윤하준", date).click();
  await admin.keyboard.type("9-18");
  await admin.keyboard.press("Enter");
  await grid.focus();
  await admin.keyboard.press("ControlOrMeta+s");
  const save = admin.getByRole("complementary", { name: /저장 · 초안 1칸/ });
  await chooseRadio(save, /출근부 \(종이\)/);
  await save.getByRole("button", { name: "1칸 저장", exact: true }).click();
  await expect(admin.getByRole("status").filter({ hasText: "1칸을 저장했습니다" })).toBeVisible();
  const history = async () => {
    const response = await api(`/attendance/people/${person}/month?month=${month}`);
    expect(response.status()).toBe(200);
    return (await response.json()).history as unknown[];
  };
  expect(await history()).toHaveLength(1);
  const restricted = kind === "lower-grant" ? exec : (await tenantBeforeSetup(browser, `${slug}foreign`, "다른기록계정", false, "none")).admin;
  const restrictedBearer = bearerOf(restricted);
  await go(restricted, "/account");
  await expect.poll(restrictedBearer).not.toBe("");
  return { admin, api, person, month, date, other, workplace, history, restrictedToken: restrictedBearer() };
}

export async function underPrincipal(page: Page, path: string, token: string, action: () => Promise<void>, status: number, code: string, text: string) {
  const matches = (url: URL) => url.pathname === `/api/v1${path}`;
  const handler = (route: Route) => route.continue({ headers: { ...route.request().headers(), authorization: token } });
  await page.route(matches, handler);
  try {
    const response = page.waitForResponse(r => matches(new URL(r.url())));
    await action();
    const actual = await response;
    expect(actual.status()).toBe(status);
    if (status === 200) {
      const preview = await actual.json();
      expect(preview.cells[0]).toMatchObject({ status: "REFUSED", code });
      expect(preview.cells[0]).not.toHaveProperty("after");
    } else expect((await actual.json()).error.code).toBe(code);
    await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
  } finally {
    await page.unroute(matches, handler);
  }
}

export const forbiddenText = () => t("crud.refused.forbidden");
