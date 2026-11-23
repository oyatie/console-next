// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { ConsoleStatusBar } from "./shell";

beforeAll(() => loadCatalog("ko"));
afterEach(() => vi.unstubAllGlobals());

// The palette opens on Command+K and on Control+K; the cap names the key this system's keyboard has.
test.each([["Win32", "Ctrl+K"], ["Linux x86_64", "Ctrl+K"], ["MacIntel", "⌘K"], ["iPad", "⌘K"]])("on %s the status bar's search cap reads %s", (platform, cap) => {
  // The cap reads the navigator only inside a page, so the test stands in for both.
  vi.stubGlobal("document", {});
  vi.stubGlobal("navigator", { platform });
  const html = renderToStaticMarkup(<ConsoleStatusBar currentTitle="Home" inboxExact />);
  expect(html).toContain(`${t("shell.jumpLabel")}</bdi><kbd`);
  expect(html).toContain(`>${cap}</kbd>`);
});
