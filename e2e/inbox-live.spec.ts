// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { atPhoneWidth, expectAccessible, fits } from "./a11y";
import { go, kstDate, unique } from "./flows";
import { apiOf, bearerOf } from "./helpers/api";
import { staffedTenant } from "./setup-flows";

const INBOX = "/api/v1/me/action-inbox";
const SOURCE_READ = /^\/api\/v1\/(employees|org-changes|org-units|branches|hr\/exit-cases|change-requests|period-locks|statutory\/insurance-filings)(\?|$)/;
type Item = { id: string; kind: string; title: string; lane: string; links: { kind: string; id: string }[] };
type Inbox = { items: Item[]; total: number; next_cursor: string | null };
const inbox = (page: Page) => page.getByRole("region", { name: "업무함", exact: true });
const readFilter = (page: Page, filter: string) => page.waitForResponse((response) => {
  const url = new URL(response.url());
  return response.request().method() === "GET" && url.pathname === INBOX && url.searchParams.get("filter") === filter;
});

test("one server queue supplies every Home filter and holds remote resolutions until refresh", { tag: ["@hr", "@live"] }, async ({ browser }, info) => {
  test.setTimeout(240_000);
  const { admin } = await staffedTenant(browser, "inboxlive", "업무함실시간");
  const bearer = bearerOf(admin);
  await go(admin, "/org");
  await admin.reload();
  await expect.poll(bearer).not.toBe("");
  const api = apiOf(admin, bearer);
  const unitsResponse = await api("/org-units");
  expect(unitsResponse.status()).toBe(200);
  const units = await unitsResponse.json() as { items: { id: string; name: string; kind: string; status: string }[] };
  const unit = units.items.find((candidate) => candidate.kind === "DEPARTMENT" && candidate.status === "ACTIVE");
  expect(unit, "the UI-created tenant has a department to draft against").toBeDefined();
  const draftResponse = await api("/org-changes", "POST", {
    kind: "REORG", target: { kind: "ORG_UNIT", ref: unit!.id, label: unique("업무함실시간변경") },
    effectiveDate: kstDate(7), reason: "다른 탭에서 취소한 초안은 업무함에서 나갑니다", proposal: [],
  }, { "Idempotency-Key": unique("inbox-live-draft") });
  expect(draftResponse.status(), await draftResponse.text()).toBe(201);
  const draft = await draftResponse.json() as { id: string };

  const reader = await admin.context().newPage();
  const sourceReads: string[] = [];
  let queueReads = 0;
  reader.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() !== "GET") return;
    if (url.pathname === INBOX) queueReads++;
    if (SOURCE_READ.test(url.pathname + url.search)) sourceReads.push(url.pathname + url.search);
  });
  const stream = reader.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/events" && response.ok());
  const firstRead = readFilter(reader, "turn");
  await reader.setViewportSize({ width: 1440, height: 900 });
  await go(reader, "/");
  await stream;
  const first = await firstRead;
  expect(first.status()).toBe(200);
  const body = await first.json() as Inbox;
  expect(body.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "org_change_draft", links: expect.arrayContaining([expect.objectContaining({ kind: "org_change", id: draft.id })]) })]));
  const draftItem = body.items.find(item => item.links.some(link => link.kind === "org_change" && link.id === draft.id))!;
  const row = inbox(reader).locator(`[data-id="${draftItem.id}"]`);
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("link", { name: "초안 편집", exact: true })).toBeVisible();
  for (const item of body.items.filter((item) => !item.kind.startsWith("setup_")))
    await expect(inbox(reader).getByText(item.title, { exact: false }).first()).toBeVisible();

  for (const [filter, label] of [["waiting", "기다리는 중"], ["scheduled", "예정"], ["deadlines", "기한 임박"], ["failures", "실패·예외"]] as const) {
    const reading = readFilter(reader, filter);
    const button = inbox(reader).getByRole("button", { name: new RegExp(`^${label} \\d+\\+?$`) });
    await button.click();
    const response = await reading;
    expect(response.status()).toBe(200);
    await expect(button).toHaveAttribute("aria-pressed", "true");
    const filtered = await response.json() as Inbox;
    if (filter === "waiting" || filter === "scheduled") expect(filtered.items.every((item) => item.lane === filter)).toBe(true);
  }
  const turn = inbox(reader).getByRole("button", { name: /^내 차례 \d+\+?$/ });
  await turn.click();
  await expect(turn).toHaveAttribute("aria-pressed", "true");
  await expect(row).toHaveCount(1);
  await expectAccessible(reader, "업무함 at 1440px, light and dark");
  await reader.screenshot({ path: info.outputPath("inbox-1440.png"), fullPage: true });
  await atPhoneWidth(reader, async () => {
    await expect(row).toBeVisible();
    await fits(reader, "업무함");
    await expectAccessible(reader, "업무함 at 390px, light and dark");
    await reader.screenshot({ path: info.outputPath("inbox-390.png"), fullPage: true });
  });

  let loads = 0;
  reader.on("load", () => { loads++; });
  const before = queueReads;
  const position = await row.boundingBox();
  const held = reader.getByRole("button", { name: /^새 항목 \d+건 · 새로 고침$/ });
  const heldBefore = await held.count() ? await held.textContent() : null;
  const cancelled = await api(`/org-changes/${draft.id}/cancel`, "POST", { reason: "다른 탭에서 업무 완료" });
  expect(cancelled.status(), await cancelled.text()).toBe(200);
  await expect(held).toBeVisible();
  await expect.poll(() => held.textContent()).not.toBe(heldBefore);
  await expect(row).toHaveCount(1);
  expect(await row.boundingBox(), "a remote resolution leaves the painted row in place").toEqual(position);
  expect(queueReads, "held changes do not refetch the painted queue").toBe(before);
  const refreshed = readFilter(reader, "turn");
  await held.click();
  const updated = await refreshed;
  expect(updated.status()).toBe(200);
  expect((await updated.json() as Inbox).items.some((item) => item.links.some((link) => link.kind === "org_change" && link.id === draft.id))).toBe(false);
  await expect(row).toHaveCount(0);
  expect(queueReads).toBeGreaterThan(before);
  expect(loads, "SSE updates the open queue without a document reload").toBe(0);
  expect(sourceReads, "Home never assembles source queues in the browser").toEqual([]);
});
