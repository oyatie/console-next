// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { apiOf, bearerOf, codeOf } from "../helpers/api";
import { peopleWorld, registerAt } from "../helpers/people-fixes";

test("solo: emergency contact notice is enforced; evidence survives sibling deletion and undo", { tag: ["@hr", "@regression", "@negative"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin } = await peopleWorld(browser, "emergencynotice");
  const api = apiOf(admin, bearerOf(admin));
  const worker = await registerAt(admin, "사람기술", "연락인", "EC-0001");
  const read = async () => (await (await api(`/employees/${worker.id}/personal-facts`)).json()) as {
    updated_at: string;
    emergency_contacts: { name: string; contact_notified: boolean; basis: string; recorded_by_name: string; recorded_at: string }[] | null;
  };
  const before = await read();
  for (const contact_notified of [undefined, null, false]) {
    const refused = await api(`/employees/${worker.id}`, "PATCH", {
      expected_updated_at: before.updated_at, reason_code: "QUICK_EDIT",
      changes: { emergency_contacts: [{ name: "이하나", relation: "SPOUSE", phone: "010-1234-5678", contact_notified }] },
    }, { "Accept-Language": "ko" });
    expect(refused.status()).toBe(422);
    expect(await codeOf(refused)).toBe("emergency_contact_notice_unconfirmed");
    expect(JSON.stringify(await refused.json())).toContain("알렸는지 확인");
    expect(await read()).toEqual(before);
  }
  for (const [name, relation, phone] of [["이하나", "배우자", "01012345678"], ["이두리", "부모", "01098765432"]]) {
    await admin.getByRole("button", { name: "비상연락처 추가", exact: true }).click();
    const sheet = admin.getByRole("dialog", { name: "비상연락처 추가" });
    await sheet.getByRole("textbox", { name: /^이름/ }).fill(name!);
    await sheet.getByLabel(/^관계/).selectOption({ label: relation! });
    await sheet.getByRole("textbox", { name: /^휴대전화/ }).fill(phone!);
    await expect(sheet.getByRole("button", { name: /인사 정보 1명 정정/ })).toHaveAttribute("aria-disabled", "true");
    await sheet.getByRole("checkbox").check();
    await sheet.getByRole("button", { name: /인사 정보 1명 정정/ }).click();
    await expect(sheet).toBeHidden();
  }
  const recorded = (await read()).emergency_contacts!;
  const contacts = admin.getByRole("list", { name: "비상연락처", exact: true });
  await expect(contacts).toContainText("응급 상황 대비 (검토 전)");
  await expect(contacts).toContainText(recorded[0]!.recorded_by_name);
  await expect(contacts).toContainText("KST");
  await expect(contacts).not.toContainText(recorded[0]!.basis);
  await expect(contacts).not.toContainText(recorded[0]!.recorded_at);
  await contacts.getByRole("button", { name: /배우자.*더보기/ }).click();
  await admin.getByRole("menuitem", { name: /삭제|무효화/ }).click();
  await expect.poll(async () => (await read()).emergency_contacts).toEqual([recorded[1]]);
  await admin.getByRole("button", { name: "되돌리기 ⌘Z", exact: true }).click();
  await expect.poll(async () => (await read()).emergency_contacts).toEqual(recorded);
  await expectAccessible(admin, "people: emergency contact evidence and undo");
});
