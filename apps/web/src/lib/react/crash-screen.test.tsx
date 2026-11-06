// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";

test("crash recovery renders while support reference code is still loading", async () => {
  await loadCatalog("ko");
  vi.resetModules();
  let release: (() => void) | undefined;
  vi.doMock("./support-reference", () => new Promise(resolve => {
    release = () => resolve({ SupportReference: () => null });
  }));
  let screen: typeof import("./crash-screen") | undefined;
  const loading = import("./crash-screen").then(module => { screen = module; });
  try {
    await vi.waitFor(() => expect(screen).toBeDefined());
    const CrashScreen = screen!.CrashScreen;
    const html = renderToStaticMarkup(<CrashScreen error={new Error("render failed")} />);
    expect(html).toContain(t("common.crashed.title"));
    expect(html).toContain(t("common.crashed.action"));
    await vi.waitFor(() => expect(release).toBeDefined());
  } finally {
    release?.();
    await loading;
    vi.doUnmock("./support-reference");
    vi.resetModules();
  }
});
