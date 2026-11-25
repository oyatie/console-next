// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { i18n, loadCatalog, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import type { Notice } from "../api";
import { NoticePage } from "./notice-page";

const state = vi.hoisted(() => ({
  notice: {
    id: "notice-1", notice_no: "AN-2026-009", notice_date: "2026-10-23", title: "Appointment notice", note: null,
    issued_at: "2026-10-23T01:00:00Z", issued_by_name: "HR Admin", line_count: 0, lines: [],
  },
}));
vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useParams: () => ({ noticeId: "notice-1" }) }),
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@tanstack/react-query", () => ({
  // One answer serves both reads: the notice, and an entity list with no entity in it.
  useQuery: () => ({ isPending: false, isSuccess: true, status: "success", error: null, data: { ...state.notice, items: [] } as unknown as Notice }),
}));
// Each button's click handler, by its label, so the test can press Copy.
const pressed = vi.hoisted(() => new Map<string, () => void>());
vi.mock("../../../ui/button/button", () => ({
  Button: ({ onClick, children }: { onClick?: () => void; children: ReactNode }) => {
    const text = [children].flat().find((child): child is string => typeof child === "string");
    if (text && onClick) pressed.set(text, onClick);
    return <span>{children}</span>;
  },
}));

beforeAll(() => loadCatalog("ko"));

test("the notice as printed and as copied text keeps the locale date form whatever day style the screen draws", () => {
  const screenStyle = i18n.dateStyle;
  const writeText = vi.fn(async (_text: string) => undefined);
  i18n.dateStyle = () => "iso";
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  try {
    expect(fmtDate("2026-10-23")).toBe("2026-10-23");
    const article = renderToStaticMarkup(<NoticePage />).match(/<article[^]*<\/article>/)?.[0] ?? "";
    expect(article).toContain(t("notice.doc.no", { no: "AN-2026-009", date: "2026. 10. 23." }));
    expect(article).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    pressed.get(t("notice.copy"))!();
    const lines = writeText.mock.calls[0]![0].split("\n");
    expect(lines[1]).toBe(t("notice.doc.no", { no: "AN-2026-009", date: "2026. 10. 23." }));
    expect(lines.at(-1)).toContain("2026. 10. 23.");
    expect(lines.join("\n")).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  } finally {
    i18n.dateStyle = screenStyle;
    vi.unstubAllGlobals();
  }
});
