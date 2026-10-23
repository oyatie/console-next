// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect } from "@playwright/test";
import { test } from "vitest";
import { options, previewPath, voidPath, registrationVoidBrowser, type Reply } from "../../../../../../e2e/registration-void.browser";

const h = registrationVoidBrowser();
const { dialog, confirm, open, choose, mount } = h;

for (const [label, code] of [["중복 등록", "DUPLICATE"], ["시험 입력", "TEST_ENTRY"], ["다른 법인의 등록증", "WRONG_DOCUMENT"]]) {
  test(`mounted certificate menu → ${label} → registration void`, async () => {
    await mount();
    await open();
    await expect(dialog()).toContainText("000-81-00028");
    await expect(dialog()).toContainText("개정 이력 7건");
    await expect(confirm()).toBeDisabled();
    // The blocked control stays focusable but cannot send even a programmatic click.
    await confirm().evaluate((button: HTMLButtonElement) => button.click());
    expect(h.writes).toEqual([]);
    await choose(label);
    await expect(confirm()).toBeEnabled();
    await confirm().click();
    await expect(dialog()).toHaveCount(0);
    expect(h.reads).toContain(previewPath);
    expect(h.writes).toHaveLength(1);
    expect(new URL(h.writes[0]!.url()).pathname).toBe(voidPath);
    expect(h.writes[0]!.postDataJSON()).toEqual({ reason_code: code });
    expect(h.writes[0]!.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });
}

test.each([
  ["linked workplace despite allowed flag", options({ linked_workplaces: [{ id: "wp-1", name: "서버에서 읽은 본점" }] }), "서버에서 읽은 본점"],
  ["record_in_use despite allowed flag", options({ delete: { allowed: true, refusal: "record_in_use" } }), "이 기록을 쓰는 곳이 있어 삭제할 수 없습니다"],
  ["phase_not_setup refusal", options({ delete: { allowed: false, refusal: "phase_not_setup" } }), "삭제 미리보기를 읽지 못했습니다"],
  ["denied without refusal", options({ delete: { allowed: false, refusal: null } }), "삭제 미리보기를 읽지 못했습니다"],
  ["revoked grant", options({ can_manage: false }), "이 계정에는 이 일을 할 권한이 없습니다"],
  ["operating", options({ phase: "OPERATING" }), "삭제할 수 없습니다"],
])("choosing a reason cannot bypass %s", async (_name, end, message) => {
  h.preview = async () => ({ json: end });
  await mount();
  await open();
  await expect(dialog()).toContainText("개정 이력 7건");
  const radio = h.page.getByRole("radio", { name: "중복 등록", exact: true });
  await expect(radio).toBeDisabled();
  await radio.evaluate((input: HTMLInputElement) => input.click());
  await expect(radio).not.toBeChecked();
  await expect(dialog()).toContainText(message);
  await expect(confirm()).toBeDisabled();
  await confirm().evaluate((button: HTMLButtonElement) => button.click());
  expect(h.writes).toEqual([]);
});

test("cached permission stays blocked during a paused offline refresh, then honors the fresh refusal", async () => {
  h.preview = async () => ({ json: options({ can_manage: false }) });
  await mount("cached");
  await h.context.setOffline(true);
  await open();
  await expect(confirm()).toBeDisabled();
  await expect(dialog()).not.toContainText("개정 이력 99건");
  expect(h.reads).toEqual([]);
  await confirm().evaluate((button: HTMLButtonElement) => button.click());
  expect(h.writes).toEqual([]);
  await h.context.setOffline(false);
  await expect(dialog()).toContainText("이 계정에는 이 일을 할 권한이 없습니다");
  await expect(confirm()).toBeDisabled();
  expect(h.reads).toEqual([previewPath]);
  expect(h.writes).toEqual([]);
});

test("a cached preview stays blocked while loading or failed; retry reads current permission", async () => {
  let release!: (reply: Reply) => void;
  const held = new Promise<Reply>((done) => { release = done; });
  h.preview = () => held;
  try {
    await mount("cached");
    await open();
    await expect(confirm()).toBeDisabled();
    await expect(dialog()).not.toContainText("개정 이력 99건");
    await confirm().evaluate((button: HTMLButtonElement) => button.click());
    expect(h.writes).toEqual([]);
    release({ status: 503, json: { error: { code: "unavailable", message: "unavailable" } } });
    await expect(dialog().getByRole("button", { name: "삭제 미리보기 다시 읽기" })).toBeVisible();
    await expect(confirm()).toBeDisabled();
    h.preview = async () => ({ json: options() });
    await dialog().getByRole("button", { name: "삭제 미리보기 다시 읽기" }).click();
    await expect(dialog()).toContainText("개정 이력 7건");
    await choose();
    await expect(confirm()).toBeEnabled();
    expect(h.writes).toEqual([]);
  } finally {
    release({ status: 503, json: { error: { code: "unavailable", message: "unavailable" } } });
  }
});

test("pending submission blocks dismissal and repeat confirmation until success", async () => {
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  h.submit = async () => { await held; return { status: 204 }; };
  try {
    await mount();
    await open();
    await choose();
    await expect(confirm()).toBeEnabled();
    await confirm().click();
    await expect(confirm()).toBeDisabled();
    await dialog().getByRole("button", { name: "돌아가기", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    expect(await dialog().count()).toBe(1);
    await h.page.keyboard.press("Escape");
    await expect(dialog()).toBeVisible();
    await h.page.mouse.click(2, 2);
    await expect(dialog()).toBeVisible();
    await confirm().evaluate((button: HTMLButtonElement) => button.click());
    expect(h.writes).toHaveLength(1);
    release();
    await expect(dialog()).toHaveCount(0);
    expect(h.writes).toHaveLength(1);
  } finally { release(); }
});

test("a command refusal keeps the dialog open and shows the server's reason", async () => {
  h.submit = async () => ({ status: 409, json: { error: { code: "record_in_use", message: "record_in_use" } } });
  await mount();
  await open();
  await choose();
  await expect(confirm()).toBeEnabled();
  await confirm().click();
  await expect(dialog().getByRole("alert")).toContainText("이 기록을 쓰는 곳이 있어 삭제할 수 없습니다");
  await expect(dialog()).toBeVisible();
  expect(h.writes).toHaveLength(1);
});

test("cancel closes without submitting and reopening requires a new preview and reason", async () => {
  await mount();
  await open();
  await choose();
  await expect(confirm()).toBeEnabled();
  await dialog().getByRole("button", { name: "돌아가기", exact: true }).click();
  await expect(dialog()).toHaveCount(0);
  h.preview = async () => ({ json: options({ can_manage: false, revisions: 8 }) });
  await open();
  await expect(dialog()).toContainText("개정 이력 8건");
  await expect(h.page.getByRole("radio", { name: "중복 등록", exact: true })).not.toBeChecked();
  await expect(h.page.getByRole("radio", { name: "중복 등록", exact: true })).toBeDisabled();
  await expect(confirm()).toBeDisabled();
  expect(h.writes).toEqual([]);
});

test.each(["locked", "closed"])("a %s certificate has no deletion menu", async (state) => {
  await mount(state);
  await expect(h.page.getByRole("button", { name: "사업자등록증 000-81-00028 더보기", exact: true })).toHaveCount(0);
  expect(h.writes).toEqual([]);
});

test("the operating certificate menu explains why deletion is unavailable", async () => {
  await mount("operating");
  await h.page.getByRole("button", { name: "사업자등록증 000-81-00028 더보기", exact: true }).click();
  await expect(h.page.getByRole("menuitem", { name: /삭제/ })).toBeDisabled();
  await expect(h.page.getByRole("menu")).toContainText("운영을 시작한 뒤에는 사업자등록증을 삭제할 수 없습니다");
  expect(h.writes).toEqual([]);
});

test("an allowed preview becomes blocked while an active refresh is fetching", async () => {
  let release!: (reply: Reply) => void;
  const held = new Promise<Reply>((done) => { release = done; });
  try {
    await mount();
    await open();
    await choose();
    await expect(confirm()).toBeEnabled();
    h.preview = () => held;
    await h.page.evaluate(() => window.dispatchEvent(new Event("registration-preview-refresh")));
    await expect(confirm()).toBeDisabled();
    await confirm().evaluate((button: HTMLButtonElement) => button.click());
    expect(h.writes).toEqual([]);
    release({ json: options({ can_manage: false }) });
    await expect(dialog()).toContainText("이 계정에는 이 일을 할 권한이 없습니다");
    await expect(confirm()).toBeDisabled();
  } finally { release({ json: options() }); }
});

test("an offline active refresh blocks an earlier allowed preview until the fresh read lands", async () => {
  await mount();
  await open();
  await choose();
  await expect(confirm()).toBeEnabled();
  // Query tracks the offline event; navigator.onLine can change before its listener runs.
  await h.page.evaluate(() => {
    window.addEventListener("offline", () => {
      window.dispatchEvent(new Event("registration-preview-refresh"));
    }, { once: true });
  });
  await h.context.setOffline(true);
  await h.page.waitForFunction(() => !navigator.onLine);
  await expect(confirm()).toBeDisabled({ timeout: 1000 });
  await confirm().evaluate((button: HTMLButtonElement) => button.click());
  expect(h.writes).toEqual([]);
  h.preview = async () => ({ json: options({ can_manage: false }) });
  await h.context.setOffline(false);
  await expect(dialog()).toContainText("이 계정에는 이 일을 할 권한이 없습니다");
  await expect(confirm()).toBeDisabled();
  expect(h.writes).toEqual([]);
});

test.each([1280, 390])("preview changes keep the dialog and controls in place at %ipx", async (width) => {
  await h.page.setViewportSize({ width, height: 844 });
  let release!: (reply: Reply) => void;
  const held = new Promise<Reply>((done) => { release = done; });
  h.preview = () => held;
  try {
    await mount();
    await open();
    await expect(h.page.getByRole("radio", { name: "중복 등록", exact: true })).toBeVisible();
    await h.page.evaluate(() => document.fonts.ready);
    const bounds = async () => Promise.all([dialog().boundingBox(), confirm().boundingBox(), dialog().getByText("중복 등록", { exact: true }).boundingBox()]);
    const loading = await bounds();
    release({ status: 503, json: { error: { code: "unavailable", message: "unavailable" } } });
    const retry = dialog().getByRole("button", { name: "삭제 미리보기 다시 읽기" });
    await expect(retry).toBeVisible();
    expect(await bounds()).toEqual(loading);
    h.preview = async () => ({ json: options({ can_manage: false }) });
    await retry.click();
    await expect(dialog()).toContainText("이 계정에는 이 일을 할 권한이 없습니다");
    expect(await bounds()).toEqual(loading);
    h.preview = async () => ({ json: options() });
    await h.page.evaluate(() => window.dispatchEvent(new Event("registration-preview-refresh")));
    await expect(h.page.getByRole("radio", { name: "중복 등록", exact: true })).toBeEnabled();
    await choose();
    await expect(confirm()).toBeEnabled();
    expect(await bounds()).toEqual(loading);
  } finally { release({ json: options() }); }
});


test("a failed preview is a read failure, with no command outcome or stale permission", async () => {
  h.preview = async () => ({ json: options({ can_manage: false }) });
  await mount();
  await open();
  await expect(dialog()).toContainText("이 계정에는 이 일을 할 권한이 없습니다");
  h.preview = async () => ({ status: 503, json: { error: { code: "unavailable", message: "unavailable" } } });
  await h.page.evaluate(() => window.dispatchEvent(new Event("registration-preview-refresh")));
  await expect(dialog().getByRole("button", { name: "삭제 미리보기 다시 읽기" })).toBeVisible();
  await expect(dialog()).toContainText("삭제 요청은 보내지 않았습니다");
  await expect(dialog()).not.toContainText("처리 여부 확인 중");
  await expect(dialog()).not.toContainText("이 계정에는 이 일을 할 권한이 없습니다");
  await expect(confirm()).toBeDisabled();
  expect(h.writes).toEqual([]);
});

test.each([
  [options({ can_manage: false }), "이 계정에는 이 일을 할 권한이 없습니다"],
  [options({ delete: { allowed: false, refusal: "record_in_use" }, linked_workplaces: [{ id: "wp-1", name: "서버 본사" }] }), "서버 본사"],
])("the preview states its blocker once and offers no purposeless reason control: %j", async (end, message) => {
  h.preview = async () => ({ json: end });
  await mount();
  await open();
  await expect(dialog().getByText(message, { exact: false })).toHaveCount(1);
  await expect(dialog().getByRole("radio", { name: "중복 등록", exact: true })).toBeDisabled();
  await expect(confirm()).toBeDisabled();
  expect(h.writes).toEqual([]);
});

test.each(["Escape", "back"])("closing with %s restores focus to the certificate menu", async (close) => {
  await mount();
  await h.page.getByRole("button", { name: /사업자등록증.*더보기/ }).focus();
  await h.page.keyboard.press("Enter");
  await h.page.getByRole("menuitem", { name: "삭제", exact: true }).press("Enter");
  await expect(dialog()).toBeVisible();
  if (close === "Escape") await h.page.keyboard.press("Escape");
  else await dialog().getByRole("button", { name: "돌아가기", exact: true }).click();
  await expect(dialog()).toHaveCount(0);
  await expect(h.page.getByRole("button", { name: /사업자등록증.*더보기/ })).toBeFocused();
  expect(h.writes).toEqual([]);
});

test("each certificate menu includes its own registration number", async () => {
  await mount("multiple");
  await expect(h.page.getByRole("button", { name: "사업자등록증 000-81-00028 더보기", exact: true })).toHaveCount(1);
  await expect(h.page.getByRole("button", { name: "사업자등록증 000-81-00071 더보기", exact: true })).toHaveCount(1);
});


test("the reason choices and submitted code come from the tenant catalog", async () => {
  const code = "T_00000000000000000000000000000001";
  h.catalog = [{ code, system: false, active: true, requires_note: false, label_ko: "회사에서 정한 사유", label_en: null }];
  await mount();
  await open();
  await choose("회사에서 정한 사유");
  await confirm().click();
  await expect(dialog()).toHaveCount(0);
  expect(h.writes[0]!.postDataJSON()).toEqual({ reason_code: code });
});


test("a failed refresh after a command refusal never says no request was sent", async () => {
  h.submit = async () => ({ status: 409, json: { error: { code: "record_in_use", message: "in use" } } });
  await mount();
  await open();
  await choose();
  h.preview = async () => ({ status: 503, json: { error: { code: "unavailable", message: "unavailable" } } });
  await confirm().click();
  await expect(dialog().getByRole("button", { name: "삭제 미리보기 다시 읽기" })).toBeVisible();
  await expect(dialog()).not.toContainText("삭제 요청은 보내지 않았습니다");
  expect(h.writes).toHaveLength(1);
});


test("an unavailable reason catalog cannot authorize a deletion", async () => {
  await mount();
  await h.page.route("**/api/v1/reason-codes?**", (route) => route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "unavailable" } } }));
  await open();
  await expect(confirm()).toBeDisabled();
  await confirm().evaluate((button: HTMLButtonElement) => button.click());
  expect(h.writes).toEqual([]);
});
