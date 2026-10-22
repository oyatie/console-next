// SPDX-License-Identifier: LicenseRef-Proprietary
import type { MouseEvent } from "react";
import type { Button } from "../../../ui/button/button";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { Sheet } from "../../../ui/sheet/sheet";
import { inviteBlock } from "../domain/sign-in-id";
import { InviteSheet } from "./account-invite-sheet";

const view = vi.hoisted(() => ({
  cursor: 0, reads: 0, nonEmployee: false, name: "", login: null as string | null,
  who: false, existing: false, checking: false, buttons: [] as Parameters<typeof Button>[0][], mutate: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => {
    const i = view.cursor++;
    if (i === 0) return [view.nonEmployee, vi.fn()];
    if (i === 2) return [view.who ? { id: "person", name: "Hong", employee_number: "HR-1" } : null, vi.fn()];
    if (i === 3) return [view.name, vi.fn()];
    if (i === 5) return [view.login, vi.fn()];
    return actual.useState(initial);
  } };
});
vi.mock("@tanstack/react-query", () => ({ useQuery: () => view.reads++ === 2
  ? { data: { items: view.existing ? [{ id: "account", employee_id: "person" }] : [] }, isFetching: view.checking }
  : { data: { items: [] }, isFetching: false } }));
vi.mock("../../../lib/react/command", () => ({ useCommand: () => ({ mutate: view.mutate }) }));
vi.mock("./use-focus-invalid", () => ({ useFocusInvalid: () => [{ current: null }, vi.fn()] }));
vi.mock("./use-issue-code", () => ({ useIssueCode: () => ({}) }));
vi.mock("../../../ui/sheet/sheet", () => ({ Sheet: (p: Parameters<typeof Sheet>[0]) => <>{p.consequence}{p.actions}</> }));
vi.mock("../../../ui/button/button", async (original) => {
  const actual = await original<typeof import("../../../ui/button/button")>();
  return { ...actual, Button: (p: Parameters<typeof Button>[0]) => { view.buttons.push(p); return <actual.Button {...p} />; } };
});
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { view.cursor = 0; view.reads = 0; view.nonEmployee = false; view.name = ""; view.login = null; view.who = false; view.existing = false; view.checking = false; view.buttons = []; view.mutate.mockClear(); });
const input = () => ({ created: false, nonEmployee: false, who: true, name: "Hong", login: "hong", existing: false, checking: false });
test.each([
  [{ who: false, name: "" }, "accounts.invite.pickWho"],
  [{ nonEmployee: true, who: false, name: " \u3000" }, "accounts.invite.pickName"],
  [{ login: "홍길동" }, "accounts.signInId.problem.nonAscii"],
  [{ login: "bad..login" }, "accounts.signInId.problem.invalid"],
  [{ existing: true }, "accounts.invite.exists"],
  [{ checking: true }, "accounts.invite.checking"],
] as const)("invite refusal %j names its remedy", (change, id) => {
  expect(inviteBlock({ ...input(), ...change })).toBe(id);
});
test("valid invites, server-default logins and code-only retries are permitted", () => {
  expect(inviteBlock(input())).toBeNull();
  expect(inviteBlock({ ...input(), login: "" })).toBeNull();
  expect(inviteBlock({ ...input(), created: true, existing: true, login: "bad..login" })).toBeNull();
  expect(inviteBlock({ ...input(), nonEmployee: true, who: false, checking: true })).toBeNull();
});
test.each([false, true])("invite primary is focusable with the exact reason once (invalid login: %s)", (invalid) => {
  view.nonEmployee = invalid; view.name = invalid ? "Hong" : ""; view.login = invalid ? "홍길동" : null;
  const html = renderToStaticMarkup(<InviteSheet onClose={vi.fn()} onIssued={vi.fn()} onOpenAccount={vi.fn()} />);
  const button = html.match(/<button[^>]*class="[^"]*btn--primary[^>]*>/)![0];
  expect(button).toContain('aria-disabled="true"');
  expect(button).toContain('type="button"');
  expect(button).not.toMatch(/\sdisabled=/);
  const id = button.match(/aria-describedby="([^"]+)"/)![1];
  const reason = t(invalid ? "accounts.signInId.problem.nonAscii" : "accounts.invite.pickWho");
  expect(html).toContain(`id="${id}">${reason}<`);
  expect(html.split(reason)).toHaveLength(2);
});
test("a complete invite enables the primary", () => {
  view.nonEmployee = true; view.name = "Hong"; view.login = "hong";
  const html = renderToStaticMarkup(<InviteSheet onClose={vi.fn()} onIssued={vi.fn()} onOpenAccount={vi.fn()} />);
  expect(html.match(/<button[^>]*class="[^"]*btn--primary[^>]*>/)![0]).not.toContain('aria-disabled');
});
test.each(["existing", "checking"] as const)("an employee invite blocked by %s explains itself and refuses the account write", (state) => {
  view.who = true; view.login = "hong"; view[state] = true;
  const html = renderToStaticMarkup(<InviteSheet onClose={vi.fn()} onIssued={vi.fn()} onOpenAccount={vi.fn()} />);
  const button = html.match(/<button[^>]*class="[^"]*btn--primary[^>]*>/)![0];
  expect(button).toContain('aria-disabled="true"');
  const id = button.match(/aria-describedby="([^\"]+)"/)![1];
  expect(html).toContain(`id="${id}">${t(state === "existing" ? "accounts.invite.exists" : "accounts.invite.checking")}<`);
  const preventDefault = vi.fn();
  view.buttons.find((p) => p.variant === "primary")!.onClick!({ preventDefault } as unknown as MouseEvent<HTMLButtonElement>);
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(view.mutate).not.toHaveBeenCalled();
});
