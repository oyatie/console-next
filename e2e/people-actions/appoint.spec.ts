import { expect, test } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { go, registerEmployee } from "../flows";
import { staffedTenant } from "../setup-flows";
import { reasonBox, sheet, todayPreset } from "../sheet";
import { apiOf, bearerOf, codeOf } from "../helpers/api";
import { hrAct } from "../record";

// 직책 임면 (spec E5-appoint, BE-EMP-UI §1) from an empty company: no list is seeded, so the one who keeps the lists adds
// 팀장 from the sheet itself and it is chosen at once; for anyone the server does not let keep them, the empty lists
// are said and nothing can be added. The server keeps the line: a bad kind, an empty label or a rank on a list that
// has none are refused and add nothing; the same label again answers the existing entry. (The Cedar 403 for a user
// without job_title_manage is BE-EMP-UI's DB test 4ac14cca: this world's every signed-in user keeps the lists.)

const titles = async (api: ReturnType<typeof apiOf>) => ((await (await api("/job-titles")).json()) as { items: { id: string; label: string }[]; can_manage: boolean });

test("appoint: the role list is filled from the sheet by the one who keeps it; the server refuses everyone else", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin } = await staffedTenant(browser, "appco", "임면주식회사");
  const api = apiOf(admin, bearerOf(admin));
  await registerEmployee(admin, { name: "김임면", number: "AP-0001" });
  const path = new URL(admin.url()).pathname;
  expect((await titles(api)).items).toHaveLength(0);

  // The one who keeps them (the ops account): 「+ 직책 추가」 adds 팀장 to the company's list and chooses it.
  // From the card's 발령 menu (opened by URL from the card itself, the record would reflow beside the sheet unattended).
  await hrAct(admin, "직책 임면");
  const s = sheet(admin, /직책 임면/);
  await s.getByRole("button", { name: "직책 추가" }).click();
  await s.getByRole("textbox", { name: "새 직책 이름" }).fill("팀장");
  await s.getByRole("button", { name: "추가", exact: true }).click();
  await expect(s.getByRole("radiogroup", { name: /^직책/ }).getByRole("radio", { name: "팀장" })).toBeChecked();
  await expectAccessible(admin, "E5-appoint: a role added from the sheet");
  await todayPreset(s).click();
  await reasonBox(s).fill("부서장 공석 보충");
  await s.getByRole("button", { name: "보직 1명 반영" }).click();
  await expect(s).toBeHidden({ timeout: 15_000 });
  await expect(admin.getByRole("region", { name: "인사 이력" })).toContainText("직책·직무를 발령했습니다");
  // The appointment holds the 팀장 just added (the history line does not name it yet: EMP-A's history view).
  const [lead] = (await titles(api)).items.filter((x) => x.label === "팀장");
  const events = ((await (await api(`/employees/${path.split("/").pop()}/lifecycle-events`)).json()) as { items: { event_type: string; to_position_kind_id?: string }[] }).items;
  expect(events.find((e) => e.event_type === "APPOINT")?.to_position_kind_id).toBe(lead!.id);

  // The server's own line, each followed by a read that shows nothing was added.
  const before = (await titles(api)).items.length;
  const again = await api("/job-titles", "POST", { kind: "POSITION", label: "팀장" });
  expect(again.status(), "the same label answers the entry it already is").toBe(200);
  // `kind` is an OpenAPI enum: a value outside it is refused on the wire (422, code `validation`,
  // field `kind`) before the domain's own `job_title_kind_invalid` can answer.
  for (const [body, code] of [
    [{ kind: "NOPE", label: "x" }, "validation"],
    [{ kind: "POSITION", label: " " }, "job_title_label_invalid"],
    [{ kind: "POSITION", label: "반장", grade_rank: 3 }, "job_title_rank_invalid"],
  ] as const) {
    const res = await api("/job-titles", "POST", body);
    expect([res.status(), await codeOf(res)]).toEqual([422, code]);
  }
  expect((await titles(api)).items.length).toBe(before);

  // Someone the server does not let keep the lists (can_manage false, as it answers them; a fresh load): the list
  // says who keeps it and offers no add.
  await admin.route("**/api/v1/job-titles", async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, json: { ...(await res.json()), can_manage: false } });
  });
  await admin.reload();
  await go(admin, `${path}?act=APPOINT`);
  await expect(s.getByRole("radiogroup", { name: /^직책/ })).toContainText("목록은 전체 범위의 조직 권한이 있는 사람이 관리합니다");
  await expect(s.getByRole("button", { name: /추가$/ })).toHaveCount(0);
});
