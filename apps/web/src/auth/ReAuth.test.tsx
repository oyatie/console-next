// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { syncDraftPrincipal, useDraft } from "../lib/react/use-draft";
import ReAuth from "./ReAuth";

const view = vi.hoisted(() => ({
  reason: "session_expired", rendering: false, index: 0, states: [] as unknown[],
  cleanups: [] as (() => void)[], buttons: new Map<string, () => void>(),
}));
vi.mock("@console/api", async (original) => ({
  ...await original<typeof import("@console/api")>(),
  session: { principal: "account-a", get ended() { return view.reason; }, subscribe: () => () => undefined },
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
    useLayoutEffect: (effect: () => (() => void) | void) => {
      const cleanup = effect();
      if (cleanup) view.cleanups.push(cleanup);
    },
    useState: <T,>(initial: T | (() => T)) => {
      if (!view.rendering) return react.useState(initial);
      const index = view.index++;
      if (!(index in view.states)) view.states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [view.states[index] as T, (value: T) => { view.states[index] = value; }] as const;
    },
  };
});
vi.mock("../ui/dialog", () => ({ Dialog: ({ children }: { children: ReactNode }) => <section>{children}</section> }));
vi.mock("../ui/button/button", () => ({ Button: ({ children, onClick }: ButtonHTMLAttributes<HTMLButtonElement>) => {
  if (onClick) view.buttons.set(renderToStaticMarkup(<>{children}</>), () => onClick({} as never));
  return <button>{children}</button>;
} }));

function Draft({ text }: { text: string }) {
  useDraft({ route: "/people/$id", record: "person", form: "exit.report", initial: { note: text }, text: (value) => value.note });
  return null;
}
function render() {
  view.index = 0;
  view.buttons.clear();
  view.rendering = true;
  try { return renderToStaticMarkup(<ReAuth />); }
  finally { view.rendering = false; }
}
const copyAction = () => [...view.buttons].find(([label]) => label.includes(t("idle.reauth.copy")))?.[1];
const writeText = vi.fn().mockResolvedValue(undefined);
beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  view.states = [];
  view.reason = "session_expired";
  writeText.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  vi.stubGlobal("sessionStorage", { getItem: () => null, removeItem: () => undefined });
});
afterEach(() => {
  view.cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});

test.each([
  ["session_expired", "idle.reauth.expired"],
  ["session_passkey_reset", "idle.reauth.reset.bare"],
  ["session_deactivated", "idle.reauth.deactivated.bare"],
] as const)("%s without a mounted draft offers no copy action or receipt", (reason, message) => {
  view.reason = reason;
  const html = render();
  expect(copyAction()).toBeUndefined();
  expect(html).not.toContain(t("idle.reauth.copy"));
  expect(html).not.toContain(t("idle.reauth.copied"));
  expect(html).not.toContain("입력 내용을 복사한 뒤");
  expect(html).toContain(t(message));
  expect(writeText).not.toHaveBeenCalled();
});

test("a mounted form with empty draft text offers no copy action", () => {
  renderToStaticMarkup(<Draft text="" />);
  render();
  expect(copyAction()).toBeUndefined();
});

test("a refused clipboard write offers the draft for manual copying without a success receipt", async () => {
  renderToStaticMarkup(<Draft text="작성 중인 퇴직 경위" />);
  writeText.mockRejectedValueOnce(new Error("denied"));
  render();
  copyAction()!();
  await vi.waitFor(() => expect(render()).toContain(t("idle.reauth.copyFailed")));
  const html = render();
  expect(html).toContain("작성 중인 퇴직 경위</textarea>");
  expect(html).not.toContain(t("idle.reauth.copied"));
});

test.each(["session_expired", "session_passkey_reset", "session_deactivated"])("%s with a mounted draft copies its text before showing a receipt", async (reason) => {
  view.reason = reason;
  renderToStaticMarkup(<Draft text="작성 중인 퇴직 경위" />);
  expect(render()).not.toContain(t("idle.reauth.copied"));
  copyAction()!();
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith("작성 중인 퇴직 경위"));
  expect(render()).toContain(t("idle.reauth.copied"));
});

test("a draft removed after rendering cannot copy an empty string or announce success", async () => {
  renderToStaticMarkup(<Draft text="작성 중인 퇴직 경위" />);
  render();
  const copy = copyAction()!;
  syncDraftPrincipal(null);
  copy();
  await Promise.resolve();
  expect(writeText).not.toHaveBeenCalled();
  expect(render()).not.toContain(t("idle.reauth.copied"));
});
