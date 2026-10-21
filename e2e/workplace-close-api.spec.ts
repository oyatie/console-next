import { expect, test } from "@playwright/test";
import { go, kstDate } from "./flows";
import { hire } from "./helpers/close";
import { addDepts } from "./helpers/structure";
import { registerBranch, startOperations, tenantInSetup } from "./setup-flows";

// UX-R2 ENDS on the wire: the close job's refusals reach the client typed and change nothing. A 전적 line that names no
// receiving unit is refused to_org_unit_id_required, a plan missing anyone is close_plan_incomplete naming them; after
// both the 사업장 is still open and no close is planned. (A 전적 that goes through: workplace-close-group.spec.)

type Plan = { workplace_id: string; people: { employee_id: string }[]; units: { org_unit_id: string }[]; job?: unknown };
type Refused = { error: { code: string; refusals?: { employee_id?: string; org_unit_id?: string; code: string }[] } };

test("the close job refuses a 전적 line and an incomplete plan on the wire, writing nothing", { tag: ["@regression", "@org"] }, async ({ browser }) => {
  const { admin } = await tenantInSetup(browser, "wpcloseapi", "전적회사", false, "본사");
  await addDepts(admin, "본사", ["인사팀"]);
  await registerBranch(admin, "전적회사", "판교지점", "0008512347");
  await addDepts(admin, "판교지점", ["개발팀"]);
  await hire(admin, "김전적", "개발팀", "판교지점");
  // The newest bearer the app itself sent (memory only). Nothing re-reads on a timer (decision #27), so the next
  // screen may well send no request at all: track every request from here instead of waiting for the next one.
  let bearer = "";
  admin.on("request", (r) => {
    const h = r.headers()["authorization"];
    if (h && r.url().includes("/api/v1/")) bearer = h;
  });
  await startOperations(admin);

  await go(admin, "/org/entities");
  const headers = { authorization: bearer };
  const entities = (await (await admin.request.get("/api/v1/legal-entities", { headers })).json()) as { items: { workplaces: { id: string; current?: { name: string } }[] }[] };
  const site = entities.items.flatMap((e) => e.workplaces).find((w) => w.current?.name === "판교지점")!.id;
  const read = async () => (await (await admin.request.get(`/api/v1/workplaces/${site}/close-plan`, { headers })).json()) as Plan;
  const post = (data: object) => admin.request.post(`/api/v1/workplaces/${site}/close-plan`, { headers: { ...headers, "Idempotency-Key": crypto.randomUUID() }, data });
  const before = await read();
  const person = before.people[0]!.employee_id;
  const unit = before.units[0]!.org_unit_id;
  const today = kstDate();

  const transfer = await post({ closed_on: today, people: [{ employee_id: person, action: "GROUP_TRANSFER" }], units: [{ org_unit_id: unit, action: "DISSOLVE" }] });
  expect(transfer.status()).toBe(422);
  const t = (await transfer.json()) as Refused;
  expect(t.error.code).toBe("close_plan_refused");
  expect(t.error.refusals).toContainEqual(expect.objectContaining({ employee_id: person, code: "to_org_unit_id_required" }));

  const partial = await post({ closed_on: today, people: [], units: [{ org_unit_id: unit, action: "DISSOLVE" }] });
  expect(partial.status()).toBe(422);
  const p = (await partial.json()) as Refused;
  expect(p.error.code).toBe("close_plan_incomplete");
  expect(p.error.refusals).toContainEqual(expect.objectContaining({ employee_id: person, code: "line_missing" }));

  // Nothing was written: the same people and 부서 are still there and no close is planned.
  const after = await read();
  expect(after.people.map((x) => x.employee_id)).toEqual([person]);
  expect(after.units.map((x) => x.org_unit_id)).toEqual([unit]);
  expect(after.job ?? null).toBeNull();
});
