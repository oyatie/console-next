import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, option } from "./flows";
import { registerAt, setName } from "./helpers/entity";
import { openTenant } from "./helpers/tenant";
import { fillEntity, setupCompany } from "./setup-flows";

// 0h (2026-10-14): with an 영문명 set, the English UI names the 법인 by it on every surface, through the one presentation
// (reference/entity/domain/names.ts). Regression: the roster scope, the register sheet's scope, the person's 소속, the
// 법인 crumb, the delete sheet and the workplace bulk edit read the 법인명 straight off the record and showed it in English.
const EN = "Nuri Co., Ltd.";
const LEGAL = "주식회사 누리";

/** `where` names the 법인 by its English name and never by its 법인명. */
async function english(where: Locator) {
  await expect(where).toContainText(EN);
  await expect(where).not.toContainText("누리");
}
const language = (p: Page, l: "en" | "ko") => p.getByRole("banner").getByLabel(l === "en" ? "언어" : "Language").selectOption(l);

test("the English UI names a 법인 by its English name on every surface, and Korean by its 법인명", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const p = await openTenant(browser, "name-en-surfaces", "표면검사");
  await setupCompany(p, "누리", "본점");
  const record = new URL(p.url()).pathname;
  await setName(p, "영문명", EN);
  // The record's header, crumb and delete sheet (offered while nobody is placed in the 법인).
  await language(p, "en");
  await expect(p.getByRole("heading", { level: 1 })).toHaveText(EN);
  await english(p.getByRole("navigation", { name: "Location" }));
  await p.getByRole("button", { name: "Preview deleting the entity" }).click();
  const remove = p.getByRole("dialog", { name: "Delete entity" });
  await expect(remove).toContainText(`Deletes ${EN},`);
  await english(remove);
  await expectAccessible(p, "delete entity sheet, English name");
  await p.keyboard.press("Escape");
  await expect(remove).toBeHidden();
  await language(p, "ko");
  await registerAt(p, "김영문", "누리", "본점");

  await language(p, "en");
  // The person's record: the head's company link and the job section's company row.
  // registerAt already opened this same record and verified its heading; avoid pushing the same route again.
  await expect(p.getByRole("heading", { name: /김영문/, level: 1 })).toBeVisible();
  await expect(p.getByRole("link", { name: EN }).first()).toBeVisible();
  await english(p.getByRole("main"));

  // The roster: its company column and its scope picker.
  await go(p, "/people");
  await english(p.getByRole("row").filter({ hasText: "김영문" }));
  await p.getByRole("button", { name: /^Scope · / }).click();
  await english(p.getByRole("dialog", { name: "Choose a scope" }));
  await p.keyboard.press("Escape");

  // The register sheet's scope (one 법인).
  await go(p, "/people/new");
  const sheet = p.getByRole("dialog", { name: "Register employee" });
  await expect(sheet).toContainText(`scope ${EN}`);
  await expect(sheet).not.toContainText("누리");
  await p.keyboard.press("Escape");

  // The 법인 list.
  await go(p, "/org/entities");
  await english(p.getByRole("grid", { name: "Legal entities" }));

  // The workplace bulk edit's picks.
  await go(p, "/org/workplaces/edit");
  await english(p.getByRole("group").filter({ has: p.getByRole("checkbox") }));

  // Korean is unchanged: the 법인명 leads and the English name is secondary.
  await language(p, "ko");
  await go(p, record);
  await expect(p.getByRole("heading", { level: 1 })).toHaveText(`${LEGAL} · ${EN}`);
  await expect(p.getByRole("navigation", { name: "위치" })).toContainText(LEGAL);
  await go(p, "/people/new");
  await expect(p.getByRole("dialog", { name: "직원 등록" })).toContainText(LEGAL);
});

/** The shell's polite live region (ui/announcer.tsx) holding exactly `text`. */
const exact = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const announced = (p: Page, text: string) => p.getByRole("status").filter({ hasText: exact(text) });

// Regression (0h, verifier): the quick sheet's receipt and its announcements, and the wizard's announcement, named the
// new 법인 by the 법인명 typed into the draft rather than through the one presentation.
test("in English, adding a 법인 names it by its English name in the receipt and every announcement", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const p = await openTenant(browser, "name-en-create", "표면생성");
  await go(p, "/org/entities");
  await language(p, "en");
  await go(p, "/org/entities?add=true");
  const s = p.getByRole("dialog", { name: "Add legal entity" });
  await option(p, "Business type", "Sole proprietor").click();
  await s.getByLabel("Trade name").fill("누리상회");
  await s.getByLabel("English name").fill("Nuri Trading");
  await s.getByRole("textbox", { name: /^Name/ }).fill("이누리");
  const quickCreate = p.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/legal-entities");
  await s.getByRole("button", { name: "Register entity", exact: true }).click();
  expect((await quickCreate).status(), "quick entity creation refused").toBe(201);
  await expect(s).toBeHidden();
  const receipt = p.getByRole("status").filter({ has: p.getByRole("button", { name: "Undo" }) });
  await expect(receipt).toContainText("Registered Nuri Trading · it shows on the org chart");
  await expect(receipt).not.toContainText("누리");
  await expect(announced(p, "Registered Nuri Trading")).toHaveCount(1);
  await expect(p.getByRole("row", { name: /Nuri Trading/ })).toBeVisible();
  const quickUndo = p.waitForResponse((r) => r.request().method() === "POST" && /^\/api\/v1\/legal-entities\/[0-9a-f-]{36}\/void$/.test(new URL(r.url()).pathname));
  await receipt.getByRole("button", { name: "Undo" }).click();
  expect((await quickUndo).status(), "quick entity undo refused").toBe(204);
  await expect(announced(p, "Undid Nuri Trading")).toHaveCount(1);
  await expect(p.getByRole("row", { name: /Nuri Trading/ })).toBeHidden();

  // The certificate wizard: filled in Korean, its English name set on the registry step, saved in English.
  await language(p, "ko");
  await go(p, "/org/entities/new");
  await fillEntity(p, "누리");
  await p.getByRole("button", { name: "이전", exact: true }).click();
  await p.getByLabel("영문명").fill(EN);
  await p.getByRole("button", { name: "다음", exact: true }).click();
  await language(p, "en");
  const created = p.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/legal-entities");
  const registered = p.waitForResponse((r) => r.request().method() === "POST" && /^\/api\/v1\/legal-entities\/[0-9a-f-]{36}\/registrations$/.test(new URL(r.url()).pathname));
  const read = p.waitForResponse((r) => r.request().method() === "GET" && /^\/api\/v1\/legal-entities\/[0-9a-f-]{36}$/.test(new URL(r.url()).pathname));
  await p.getByRole("button", { name: "Register the entity only" }).click();
  expect((await created).status(), "entity creation refused").toBe(201);
  expect((await registered).status(), "business registration refused").toBe(201);
  await read;
  await expect(p.getByRole("heading", { level: 1 })).toHaveText(EN);
  await expect(announced(p, `Registered ${EN}`)).toHaveCount(1);
});
