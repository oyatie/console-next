// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { i18n, loadCatalog } from "@console/i18n";
import { ProfileCard } from "./profile-card";
const state = vi.hoisted(() => ({ platform: false }));
vi.mock("./profile-name", () => ({ ProfileName: () => null }));
vi.mock("../api", () => ({ claims: () => ({ name: "", platform: state.platform }), signOutHere: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
beforeAll(async () => { await loadCatalog("ko"); await loadCatalog("en"); });
test.each(["ko", "en"] as const)("%s: an unnamed account uses catalog copy and a chosen name is preserved", (locale) => {
  i18n.set(locale);
  try {
    const unnamed = renderToStaticMarkup(<ProfileCard locale={null} me={{ data: { display_name: "", name_unset: true } } as never} />);
    expect(unnamed).toContain(locale === "ko" ? "이름 미등록" : "Name not set");
    expect(unnamed).not.toContain("Cold Start Admin");
    expect(renderToStaticMarkup(<ProfileCard locale={null} me={{ data: { display_name: "박관리자" } } as never} />)).toContain("박관리자");
    state.platform = true;
    expect(renderToStaticMarkup(<ProfileCard locale={null} me={{} as never} />)).toContain(locale === "ko" ? "이름 미등록" : "Name not set");
  } finally { state.platform = false; i18n.set("ko"); }
});
