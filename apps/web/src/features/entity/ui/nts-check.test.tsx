// SPDX-License-Identifier: LicenseRef-Proprietary
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { BusinessRegistration, LegalEntity } from "@console/api/pending";
import { loadCatalog, t } from "@console/i18n";
import { NtsCheck } from "./nts-check";
import { verificationState } from "../present";
import { ApiError, type CheckEvidence, type CheckHistory } from "../api";
import type { Button } from "../../../ui/button/button";
import type { Sheet } from "../../../ui/sheet/sheet";

const view = vi.hoisted(() => ({ data: undefined as CheckHistory | undefined, queryError: null as unknown, error: null as unknown, reviewing: false, pending: false, buttons: [] as Parameters<typeof Button>[0][], mutate: vi.fn(), setReviewing: vi.fn(), run: undefined as undefined | ((kind: string, key: string) => unknown) }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useState: () => [view.reviewing, view.setReviewing] }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: view.data, error: view.queryError, isPending: false, refetch: vi.fn() }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ to, hash, children }: { to: string; hash?: string; children: ReactNode }) => <span data-href={`${to}${hash ? `#${hash}` : ""}`}>{children}</span> }));
vi.mock("../../../lib/react/command", async (original) => ({ ...await original<typeof import("../../../lib/react/command")>(), useCommand: (opts: { run: typeof view.run }) => { view.run = opts.run; return { error: view.error, isPending: view.pending, mutate: view.mutate }; } }));
vi.mock("../../../ui/button/button", async (original) => { const actual = await original<typeof import("../../../ui/button/button")>(); return { ...actual, Button: (props: Parameters<typeof Button>[0]) => { view.buttons.push(props); return createElement(actual.Button, props); } }; });
vi.mock("../../../ui/sheet/sheet", () => ({ Sheet: (p: Parameters<typeof Sheet>[0]) => p.open ? <div role="dialog">{p.title}{p.children}{p.consequence}{p.notice}{p.actions}</div> : null }));
vi.mock("../api", async (original) => ({ ...await original<typeof import("../api")>(), ENTITY_READS: [], registrationChecksQuery: vi.fn(() => ({})), checkRegistration: vi.fn(), fieldIssues: () => [] }));

const entity = { id: "entity", can_manage: true, current: { representatives: ["김등록", "이공동"] } } as LegalEntity;
const registration = { id: "registration", closed_on: null, brn: { value: "0000000029", display: "000-00-00029" }, current: { opened_on: "2026-10-01", status: "CONTINUING" } } as BusinessRegistration;
const evidence = (over: Partial<CheckEvidence> = {}): CheckEvidence => ({ id: "check", brn_checked: "0000000029", response_sha256: "a".repeat(64), provider_version: "fake/1", registration_id: "registration", checked_at: "2026-10-24T02:00:00Z", kind: "STATUS", status_code: "01", not_registered: false, fields_sent: ["b_no"], recorded_status_mismatch: false, reflection_pending: false, ...over });
const history = (check?: CheckEvidence, available = true): CheckHistory => ({ items: check ? [check] : [], latest_status: check?.kind === "STATUS" ? check : null, latest_validate: check?.kind === "VALIDATE" ? check : null, availability: { available, reason: available ? null : "NOT_CONFIGURED" } });
const html = (props: Partial<Parameters<typeof NtsCheck>[0]> = {}) => renderToStaticMarkup(<NtsCheck entity={entity} registration={registration} onAttach={vi.fn()} {...props} />);
const button = (key: Parameters<typeof t>[0]) => view.buttons.find((p) => p.children === t(key));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { view.data = history(); view.queryError = null; view.error = null; view.reviewing = false; view.pending = false; view.buttons = []; view.mutate.mockClear(); view.setReviewing.mockClear(); });

test("an unchecked number offers status and explicit validation actions", () => {
  expect(html()).toContain(t("enum.verification.NONE"));
  expect(button("nts.action.status")).toBeDefined();
  expect(button("nts.action.validate")).toBeDefined();
  expect(view.mutate).not.toHaveBeenCalled();
});

test.each(["NOT_CONFIGURED", "KEY_EXPIRED", "KEY_REJECTED", "PROVIDER_DOWN"] as const)("unavailable %s explains the reason, offers attachment, and cannot claim success", (reason) => {
  view.data = { ...history(undefined, false), availability: { available: false, reason } };
  const out = html();
  expect(out).toContain(t("nts.state.unavailable"));
  expect(out).toContain(t(`nts.unavailable.${reason}`));
  expect(out).toContain(t("nts.fallback"));
  expect(button("nts.attach")).toBeDefined();
  expect(button("nts.action.status")).toBeUndefined();
  expect(button("nts.action.validate")).toBeUndefined();
  expect(out).not.toContain(t("enum.verification.T2"));
});

test.each(["KEY_EXPIRED", "KEY_REJECTED", "PROVIDER_DOWN"] as const)("a command that becomes unavailable reports %s immediately", (reason) => {
  view.error = new ApiError(409, "registration_check_unavailable", "", [], undefined, true, [], { details: { reason } });
  const out = html();
  expect(out).toContain(t(`nts.unavailable.${reason}`));
  expect(button("nts.action.status")).toBeUndefined();
  expect(button("nts.attach")).toBeDefined();
});

test.each([
  [evidence(), "nts.result.continuing", "enum.verification.T1"],
  [evidence({ status_code: "02" }), "nts.result.suspended", "enum.verification.T1"],
  [evidence({ status_code: "03", end_dt: "20261020" }), "nts.result.closed", "enum.verification.T1"],
  [evidence({ kind: "VALIDATE", valid: "01" }), "nts.result.continuing", "enum.verification.T2"],
  [evidence({ kind: "VALIDATE", valid: "02", status_code: null, fields_sent: ["b_no", "start_dt", "p_nm"] }), "nts.result.invalid", "nts.state.unavailable"],
] as const)("a checked result renders %s", (check, result, state) => {
  view.data = history(check);
  const out = html();
  expect(out).toContain(t(state));
  expect(verificationState({ ...registration, nts_check: check, verification_tier: check.valid === "01" ? "T2" : check.status_code ? "T1" : "NONE", unverified_reason: "NOT_CHECKED" }).label).toBe(t(state));
  expect(out).toContain(result === "nts.result.closed" ? t(result, { date: "2026. 10. 20." }) : t(result));
  expect(out).toContain("2026. 10. 24. 11:00 KST");
  if (check.valid === "02") {
    expect(out).toContain(t("nts.result.invalidWhy"));
    for (const field of ["nts.validate.brn", "nts.validate.openedOn", "nts.validate.representative"] as const) expect(out).toContain(t(field));
    expect(out).not.toContain(t("enum.verification.T2"));
  }
});

test.each([true, false])("not registered reflection pending=%s keeps the provider lag honest", (pending) => {
  const check = evidence({ status_code: null, not_registered: true, reflection_pending: pending, recorded_status_mismatch: !pending, inbox_item_id: pending ? null : "inbox-item" });
  view.data = history(check);
  expect(verificationState({ ...registration, nts_check: check, verification_tier: "NONE", unverified_reason: "NOT_CHECKED" }).label).toBe(t("nts.state.unavailable"));
  const out = html();
  expect(out).toContain(t("nts.result.notRegistered"));
  expect(out.includes(t("nts.reflectionPending"))).toBe(pending);
  expect(out.includes(t("nts.mismatch"))).toBe(!pending);
  if (!pending) expect(out).toContain('data-href="/#nts-inbox-item"');
});

test("a closed provider answer keeps its date and links the mismatch to its inbox item", () => {
  view.data = history(evidence({ status_code: "03", end_dt: "20261020", recorded_status_mismatch: true, inbox_item_id: "closed-item" }));
  const out = html();
  expect(out).toContain(t("nts.result.closed", { date: "2026. 10. 20." }));
  expect(out).toContain(t("nts.mismatch"));
  expect(out).toContain('data-href="/#nts-closed-item"');
});

test.each([
  [{ ...registration, brn: null }, "nts.action.noNumber"],
  [{ ...registration, voided: true }, "nts.action.ended"],
] as const)("a registration without an eligible number cannot run checks", (r, reason) => {
  expect(html({ registration: r })).toContain(t(reason));
  expect(button("nts.action.status")).toBeUndefined();
  expect(button("nts.action.validate")).toBeUndefined();
});

test("read-only readers cannot invoke governed checks", () => {
  expect(html({ canManage: false })).toContain(t("nts.action.noPermission"));
  expect(button("nts.action.status")).toBeUndefined();
  expect(button("nts.action.validate")).toBeUndefined();
});

test.each([
  { ...entity, current: { representatives: [] } },
  { ...entity, current: null },
])("missing validation values preserve the status action without a validation action", (e) => {
  expect(html({ entity: e as LegalEntity })).toContain(t("nts.action.incomplete"));
  expect(button("nts.action.status")).toBeDefined();
  expect(button("nts.action.validate")).toBeUndefined();
});

test("validation first shows the exact provider values and purpose, then sends only on confirmation", async () => {
  html();
  button("nts.action.validate")!.onClick!({} as never);
  expect(view.setReviewing).toHaveBeenCalledWith(true);
  expect(view.mutate).not.toHaveBeenCalled();
  view.reviewing = true;
  const out = html();
  for (const value of ["0000000029", "20261001", "김등록", t("nts.validate.purpose")]) expect(out).toContain(value);
  expect(out).not.toContain("이공동");
  button("nts.validate.send")!.onClick!({} as never);
  expect(view.mutate).toHaveBeenCalledWith("VALIDATE");
  const { checkRegistration } = await import("../api");
  await view.run!("VALIDATE", "intent-key");
  expect(checkRegistration).toHaveBeenCalledWith("registration", "VALIDATE", "intent-key", { brn: "0000000029", opened_on: "2026-10-01", representative: "김등록" });
});

test("a provider quota refusal exposes the server retry delay", () => {
  view.error = new ApiError(429, "registration_check_rate_limited", "", [], undefined, true, [], { retryAfterMs: 30_000 });
  expect(html()).toContain(t("nts.rateLimited", { seconds: 30 }));
});

test("a pending request cannot send another status or validation request", () => {
  view.pending = true;
  view.reviewing = true;
  html();
  button("nts.action.status")!.onClick!({} as never);
  button("nts.validate.send")!.onClick!({} as never);
  expect(view.mutate).not.toHaveBeenCalled();
});

test("historical records use only evidence projected by the server and offer no commands", () => {
  view.data = history(evidence({ checked_at: "2099-01-01T00:00:00Z", status_code: "03" }));
  const markup = html({ historical: true, registration: { ...registration, nts_check: evidence({ checked_at: "2026-10-01T00:00:00Z" }) } });
  expect(markup).not.toContain("2099");
  expect(markup).toContain("2026");
  expect(button("nts.action.status")).toBeUndefined();
  expect(button("nts.action.validate")).toBeUndefined();
});

test("closed registrations remain eligible for an authority recheck", () => {
  html({ registration: { ...registration, closed_on: "2026-10-20", current: { ...registration.current!, status: "CLOSED" } } });
  expect(button("nts.action.status")).toBeDefined();
});
