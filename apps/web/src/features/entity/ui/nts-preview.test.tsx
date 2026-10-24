// SPDX-License-Identifier: LicenseRef-Proprietary
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { ApiError, type CheckAnswer, type CheckAvailability, type CheckPreview } from "../api";
import { emptyDraft } from "../domain/draft";
import type { CreateState } from "./use-create";
import type { Button, Check } from "../../../ui/button/button";
import type { DateField } from "../../../ui/date/date-field";
import type { Sheet } from "../../../ui/sheet/sheet";
import { NtsPreview } from "./nts-preview";

const view = vi.hoisted(() => ({ availability: { available: true, reason: null } as CheckAvailability, error: null as unknown, reviewing: false, pending: false, cursor: 0, data: undefined as CheckPreview | undefined, buttons: [] as Parameters<typeof Button>[0][], checks: [] as Parameters<typeof Check>[0][], dates: [] as Parameters<typeof DateField>[0][], mutate: vi.fn(), setReviewing: vi.fn(), opts: undefined as undefined | { run: (kind: "STATUS" | "VALIDATE", key: string) => Promise<CheckPreview>; onSuccess: (result: CheckPreview) => void } }));
vi.mock("react", async (original) => { const actual = await original<typeof import("react")>(); return { ...actual, useState: (initial: unknown) => view.cursor++ === 0 ? [view.reviewing, view.setReviewing] : actual.useState(initial) }; });
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: view.availability, error: null, isPending: false, refetch: vi.fn() }) }));
vi.mock("../../../lib/react/command", async (original) => ({ ...await original<typeof import("../../../lib/react/command")>(), useCommand: (opts: NonNullable<typeof view.opts>) => { view.opts = opts; return { data: view.data, error: view.error, isPending: view.pending, mutate: view.mutate }; } }));
vi.mock("../../../ui/button/button", async (original) => { const actual = await original<typeof import("../../../ui/button/button")>(); return { ...actual,
  Button: (props: Parameters<typeof Button>[0]) => { view.buttons.push(props); return createElement(actual.Button, props); },
  Check: (props: Parameters<typeof Check>[0]) => { view.checks.push(props); return createElement(actual.Check, props); },
}; });
vi.mock("../../../ui/date/date-field", async (original) => { const actual = await original<typeof import("../../../ui/date/date-field")>(); return { ...actual, DateField: (props: Parameters<typeof DateField>[0]) => { view.dates.push(props); return createElement(actual.DateField, props); } }; });
vi.mock("../../../ui/sheet/sheet", () => ({ Sheet: (p: Parameters<typeof Sheet>[0]) => p.open ? <div role="dialog">{p.title}{p.children}{p.notice}{p.actions}</div> : null }));
vi.mock("../api", async (original) => ({ ...await original<typeof import("../api")>(), previewRegistrationCheck: vi.fn() }));

const draft = () => ({ ...emptyDraft(), brn: "0000000029", openedOn: "2026-10-01", representatives: ["김등록", "이공동"] });
const answer = (over: Partial<CheckAnswer> = {}): CheckAnswer => ({ brn_checked: draft().brn, kind: "STATUS", status_code: "01", reported_status: "CONTINUING", not_registered: false, fields_sent: ["b_no"], response_sha256: "0".repeat(64), provider_version: "fixture", ...over });
const preview = (over: Partial<CheckPreview> = {}): CheckPreview => ({ answer: answer(), command_id: "intent", values: { brn: draft().brn, opened_on: draft().openedOn, representative: "김등록" }, acknowledged: false, ...over });
const state = (p: CheckPreview | null = null) => ({ draft: draft(), preview: p, setPreview: vi.fn(), today: "2026-10-24" }) as unknown as CreateState;
const html = (c = state()) => { view.cursor = 0; view.buttons = []; view.checks = []; view.dates = []; return renderToStaticMarkup(<NtsPreview c={c} />); };
const button = (key: Parameters<typeof t>[0]) => view.buttons.find((props) => props.children === t(key));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { view.availability = { available: true, reason: null }; view.error = null; view.reviewing = false; view.pending = false; view.data = undefined; view.mutate.mockClear(); view.setReviewing.mockClear(); });

test("an optional status check discloses only the provider's business-number input", () => {
  const out = html();
  expect(out).toContain(draft().brn);
  expect(out).not.toContain("김등록");
  expect(out).not.toContain("20261001");
  expect(out).toContain(t("nts.preview.skipped"));
  button("nts.preview.status")!.onClick!({} as never);
  expect(view.mutate).toHaveBeenCalledWith("STATUS");
});

test("validation requires an explicit confirmation showing the exact external values", () => {
  html();
  button("nts.action.validate")!.onClick!({} as never);
  expect(view.setReviewing).toHaveBeenCalledWith(true);
  expect(view.mutate).not.toHaveBeenCalled();
  view.reviewing = true;
  const out = html();
  for (const value of [draft().brn, "20261001", "김등록", t("nts.validate.purpose")]) expect(out).toContain(value);
  expect(out).not.toContain("이공동");
  button("nts.validate.send")!.onClick!({} as never);
  expect(view.mutate).toHaveBeenCalledWith("VALIDATE");
});

test("the server result retains its command and exact snapshot for atomic adoption", async () => {
  const c = state();
  html(c);
  const { previewRegistrationCheck } = await import("../api");
  vi.mocked(previewRegistrationCheck).mockResolvedValueOnce(answer());
  const result = await view.opts!.run("STATUS", "request-key");
  expect(previewRegistrationCheck).toHaveBeenCalledWith("request-key", { kind: "STATUS", brn: draft().brn, opened_on: draft().openedOn, representative: "김등록" });
  expect(result).toMatchObject({ command_id: "request-key", values: preview().values, acknowledged: false });
  view.opts!.onSuccess(result);
  expect(c.setPreview).toHaveBeenCalledWith(result);
});

test.each(["NOT_CONFIGURED", "KEY_EXPIRED", "KEY_REJECTED", "PROVIDER_DOWN"] as const)("unavailable %s offers the existing original attachment instead of a fake result", (reason) => {
  view.availability = { available: false, reason };
  const out = html();
  expect(out).toContain(t(`nts.unavailable.${reason}`));
  expect(out).toContain(t("nts.fallback"));
  expect(button("nts.attach")).toBeDefined();
  expect(button("nts.preview.status")).toBeUndefined();
  expect(button("nts.action.validate")).toBeUndefined();
});

test.each(["SUSPENDED", "CLOSED"] as const)("a %s answer asks for acknowledgement without preventing the optional skip", (status) => {
  const p = preview({ answer: answer({ reported_status: status, status_code: status === "CLOSED" ? "03" : "02", end_dt: status === "CLOSED" ? "20261020" : null }) });
  const c = state(p);
  const out = html(c);
  expect(out).toContain(t("nts.preview.warning"));
  const ack = view.checks.find((props) => props.children === t("nts.preview.ack"))!;
  expect(ack.checked).toBe(false);
  ack.onChange(true);
  expect(c.setPreview).toHaveBeenCalledWith({ ...p, acknowledged: true });
  button("nts.preview.clear")!.onClick!({} as never);
  expect(c.setPreview).toHaveBeenCalledWith(null);
  if (status === "CLOSED") expect(out).toContain("2026. 10. 20.");
});

test("a suspended answer asks for the person's recorded start date, never a guessed provider date", () => {
  const p = preview({ answer: answer({ reported_status: "SUSPENDED", status_code: "02" }) });
  const c = state(p);
  html(c);
  const date = view.dates.find((props) => props.label === t("nts.preview.statusSince"))!;
  expect(date).toMatchObject({ required: true, value: "", min: draft().openedOn, max: c.today });
  date.onChange("2026-10-21");
  expect(c.setPreview).toHaveBeenCalledWith({ ...p, status_since: "2026-10-21" });
});

test("a changed input marks the old preview stale and cannot expose its old result", () => {
  view.data = preview({ answer: answer({ valid: "01", kind: "VALIDATE" }) });
  const c = state();
  c.draft.brn = "0000000034";
  const out = html(c);
  expect(out).toContain(t("nts.preview.stale"));
  expect(out).not.toContain(t("enum.verification.T2"));
});

test("a number or opening date still missing never sends a check", () => {
  const c = state();
  c.draft.openedOn = "";
  html(c);
  expect(button("nts.preview.status")).toBeUndefined();
  expect(view.mutate).not.toHaveBeenCalled();
});

test("a provider refusal keeps its retry delay and never creates a preview", () => {
  view.error = new ApiError(429, "registration_check_rate_limited", "", [], undefined, true, [], { retryAfterMs: 30_000 });
  const c = state();
  expect(html(c)).toContain(t("nts.rateLimited", { seconds: 30 }));
  expect(c.setPreview).not.toHaveBeenCalled();
});
