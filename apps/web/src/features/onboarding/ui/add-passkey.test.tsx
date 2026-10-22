// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { AddPasskey } from "./add-passkey";
const state = vi.hoisted(() => ({ add: vi.fn(), focus: vi.fn(), options: undefined as undefined | { run: () => unknown; invalidates: string[]; onSuccess: () => void } }));
vi.mock("../api", () => ({ addPasskey: state.add, SETUP_READS: ["/api/v1/onboarding"] }));
vi.mock("../../../lib/react/announce", () => ({ focusSoon: state.focus }));
vi.mock("../../../lib/react/command", () => ({ useCommand: (options: NonNullable<typeof state.options>) => { state.options = options; return { isPending: false }; } }));
beforeAll(() => loadCatalog("ko"));
test("Home adds the second key in place, refreshes its queue and recovers focus after the row leaves", async () => {
  const html = renderToStaticMarkup(<AddPasskey count={1} primary label={t("account.second.add")} focusAfter="inbox-title" />);
  expect(html).toContain(t("account.second.add"));
  await state.options!.run();
  expect(state.add).toHaveBeenCalledWith(1);
  expect(state.options!.invalidates).toEqual(expect.arrayContaining(["/api/v1/auth/passkeys", "/api/v1/me/action-inbox"]));
  state.options!.onSuccess();
  expect(state.focus).toHaveBeenCalledWith("inbox-title");
});
